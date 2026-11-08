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

const doneKey = (id: number, dryRun: boolean) => `done:${dryRun ? "dry" : "live"}:${id}`;

const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));

function existingBonusEntries(pirepData: Record<string, unknown> | null, prefix: string): PointEntry[] {
  const raw = pirepData?.["bonus_scores"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is PointEntry => typeof e === "object" && e !== null && typeof (e as PointEntry).name === "string")
    .filter((e) => !e.name.startsWith(prefix))
    .map(({ name, points, type, id }) => ({ name, points: Number(points), ...(type ? { type } : {}), ...(id ? { id } : {}) }));
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

    const score = scoreTouchdown(td.distance_from_start_ft!, td.lda, cfg);
    const distM = Math.round(score.distM);
    const runway = td.runway;

    const detail = await api.getPirep(pirep.id);
    const entries = existingBonusEntries(detail.pirep_data, cfg.entryPrefix);
    if (score.points !== 0) {
      entries.push({ name: `${cfg.entryPrefix} ${score.label} (${distM} m, ${runway ?? "rwy ?"})`, points: score.points });
    }

    const comment =
      `**Touchdown zone:** ${distM} m from the start of ${runway ?? "the runway"} ` +
      `(TDZ ends at ${Math.round(score.tdzEndM)} m) → ${score.label}, ${fmt(score.points)} pts.` +
      (score.action === "reject" ? " Landed beyond the touchdown zone: PIREP rejected." : "") +
      (score.action === "review" ? " Touchdown before the threshold, flagged for staff review." : "");

    const willReject = score.action === "reject" && pirep.status !== "rejected";

    if (!opts.dryRun) {
      if (score.points !== 0) await api.putBonusPoints(pirep.id, entries);
      await api.addComment(pirep.id, comment);
      if (willReject) await api.reject(pirep.id);
    }

    return finish({ ...base, outcome: "scored", runway, score, bonusEntries: entries, rejected: willReject, comment });
  } catch (err) {
    return finish({ ...base, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One poll: process every PIREP newer than the last one seen.
 * The very first run only records the newest id (no backfill of history).
 */
export async function runCycle(
  api: VamsysPort,
  store: Store,
  cfg: TdzConfig,
  opts: Options,
  maxPerRun = 100,
): Promise<Result[]> {
  const lastSeen = Number((await store.get("lastSeenId")) ?? 0);

  const fresh: PirepSummary[] = [];
  let cursor: string | undefined;
  outer: do {
    const page = await api.listPireps(50, cursor);
    if (!lastSeen) {
      const newest = page.data[0];
      if (newest) await store.put("lastSeenId", String(newest.id));
      return [];
    }
    for (const p of page.data) {
      if (p.id <= lastSeen || fresh.length >= maxPerRun) break outer;
      fresh.push(p);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const results: Result[] = [];
  for (const p of fresh.reverse()) {
    // oldest first, so lastSeenId only ever moves forward
    results.push(await processPirep(api, store, p, cfg, opts));
    await store.put("lastSeenId", String(p.id));
  }
  return results;
}
