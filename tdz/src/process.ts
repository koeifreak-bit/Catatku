import type { TdzConfig } from "./config";
import { scoreTouchdown, type Score } from "./score";
import type { PirepSummary, PointEntry, VamsysPort } from "./vamsys";

/** Subset of Workers KV we use (easy to fake in tests). */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface Options {
  dryRun: boolean;
  /** Re-score even if this PIREP was already handled in this mode. */
  force?: boolean;
}

export type Outcome = "scored" | "skipped" | "error";

export interface Result {
  pirepId: number;
  callsign: string | null;
  outcome: Outcome;
  reason?: string;
  dryRun: boolean;
  runway?: string | null;
  score?: Score;
  bonusEntries?: PointEntry[];
  rejected?: boolean;
  comment?: string;
  at: string;
}

const SKIP_STATUSES = new Set(["rejected", "invalidated", "invalid"]);
const RESULT_TTL = 60 * 60 * 24 * 60; // 60 days
/** A PIREP that keeps failing (API errors) is retried on this many cycles, then given up on. */
export const MAX_ATTEMPTS = 3;

const doneKey = (id: number, dryRun: boolean) => `done:${dryRun ? "dry" : "live"}:${id}`;

const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Existing bonus entries (event, rank, activity...) minus our own, which gets re-added. */
function existingBonusEntries(pirepData: Record<string, unknown> | null, prefix: string) {
  const raw = pirepData?.["bonus_scores"];
  const all = (Array.isArray(raw) ? raw : []).filter(
    (e): e is PointEntry => typeof e === "object" && e !== null && typeof (e as PointEntry).name === "string",
  );
  const others = all
    .filter((e) => !e.name.startsWith(prefix))
    .map(({ name, points, type, id }) => ({ name, points: Number(points), ...(type ? { type } : {}), ...(id ? { id } : {}) }));
  return { others, hadOwn: others.length !== all.length };
}

export async function processPirep(
  api: VamsysPort,
  store: Store,
  pirep: PirepSummary,
  cfg: TdzConfig,
  opts: Options,
): Promise<Result> {
  const base = { pirepId: pirep.id, callsign: pirep.callsign, dryRun: opts.dryRun, at: new Date().toISOString() };
  const finish = async (r: Result) => {
    await store.put(`result:${pirep.id}`, JSON.stringify(r), { expirationTtl: RESULT_TTL });
    if (r.outcome !== "error") await store.put(doneKey(pirep.id, opts.dryRun), "1", { expirationTtl: RESULT_TTL });
    return r;
  };

  if (!opts.force && (await store.get(doneKey(pirep.id, opts.dryRun)))) {
    return { ...base, outcome: "skipped", reason: "already processed" };
  }
  if (SKIP_STATUSES.has(pirep.status)) return finish({ ...base, outcome: "skipped", reason: `status ${pirep.status}` });
  if (pirep.type === "claim") return finish({ ...base, outcome: "skipped", reason: "claim" });

  try {
    const touchdowns = await api.getTouchdowns(pirep.id);
    // The final touchdown is the landing that counts (earlier ones are bounces / go-arounds).
    const td = [...touchdowns].reverse().find((t) => t.distance_from_start_ft != null);
    if (!td) return finish({ ...base, outcome: "skipped", reason: "no touchdown data" });

    // vAMSYS `lda` is the runway REMAINING after touchdown, so the runway length is distance + lda.
    const dist = td.distance_from_start_ft!;
    const runwayFt = td.lda != null ? dist + td.lda : null;
    const score = scoreTouchdown(dist, runwayFt, cfg);
    const distM = Math.round(score.distM);
    const runway = td.runway;

    const detail = await api.getPirep(pirep.id);
    const { others: entries, hadOwn } = existingBonusEntries(detail.pirep_data, cfg.entryPrefix);
    if (score.points !== 0) {
      entries.push({ name: `${cfg.entryPrefix} ${score.label} (${distM} m, ${runway ?? "rwy ?"})`, points: score.points });
    }

    const comment =
      `**Touchdown zone:** ${distM} m from the start of ${runway ?? "the runway"} ` +
      `(TDZ markings end at ${Math.round(score.tdzEndM)} m) → ${score.label}, ${fmt(score.points)} pts.` +
      (score.action === "reject" ? " Landed beyond the touchdown zone: PIREP rejected." : "") +
      (score.action === "review" ? " Touchdown before the threshold, flagged for staff review." : "");

    const willReject = score.action === "reject" && pirep.status !== "rejected";

    if (!opts.dryRun) {
      // Write when we add an entry, or when a re-score must remove our old one.
      if (score.points !== 0 || hadOwn) await api.putBonusPoints(pirep.id, entries);
      await api.addComment(pirep.id, comment);
      if (willReject) await api.reject(pirep.id);
    }

    return finish({ ...base, outcome: "scored", runway, score, bonusEntries: entries, rejected: willReject, comment });
  } catch (err) {
    return finish({ ...base, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One poll: process every PIREP newer than the last one seen, oldest first.
 * The very first run only records the newest id (no backfill of history).
 * On an API error the cycle stops without moving past that PIREP, so it is retried next cycle
 * (up to MAX_ATTEMPTS times, then it is skipped so one broken PIREP can't block the queue).
 */
export async function runCycle(
  api: VamsysPort,
  store: Store,
  cfg: TdzConfig,
  opts: Options,
  maxPerRun = 100,
  maxScan = 1000,
): Promise<Result[]> {
  const lastSeen = Number((await store.get("lastSeenId")) ?? 0);

  const fresh: PirepSummary[] = []; // newest first
  let cursor: string | undefined;
  outer: do {
    const page = await api.listPireps(50, cursor);
    if (!lastSeen) {
      const newest = page.data[0];
      if (newest) await store.put("lastSeenId", String(newest.id));
      return [];
    }
    for (const p of page.data) {
      if (p.id <= lastSeen || fresh.length >= maxScan) break outer;
      fresh.push(p);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const batch = fresh.reverse().slice(0, maxPerRun); // oldest first; the rest waits for the next cycle
  const results: Result[] = [];
  for (const p of batch) {
    const r = await processPirep(api, store, p, cfg, opts);
    results.push(r);
    if (r.outcome === "error") {
      const attempts = Number((await store.get(`attempts:${p.id}`)) ?? 0) + 1;
      await store.put(`attempts:${p.id}`, String(attempts), { expirationTtl: 60 * 60 * 24 * 7 });
      if (attempts < MAX_ATTEMPTS) break; // retry this PIREP next cycle
    }
    await store.put("lastSeenId", String(p.id));
  }
  return results;
}
