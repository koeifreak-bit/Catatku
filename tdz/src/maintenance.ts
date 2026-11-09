/**
 * Automatic aircraft maintenance: hides an aircraft in Phoenix (vAMSYS pilot site) while it is
 * "in the hangar", then shows it again when the check is over.
 *
 * Triggers (per aircraft / registration):
 *  - scheduled checks by flight hours or cycles since that check was last done
 *  - hard landings (landing rate or G beyond a limit)
 */
import type { Store } from "./process";
import type { Aircraft, PirepSummary, VamsysPort } from "./vamsys";

export interface CheckRule {
  name: string;
  everyHours: number;
  everyCycles: number;
  durationH: number;
}

export interface HardLandingRule {
  name: string;
  /** Triggers when landing_rate <= rateFpm (e.g. -600). */
  rateFpm: number;
  /** ...or when landing_g >= g. */
  g: number;
  durationH: number;
}

export interface MxConfig {
  /** Historic fleets: never counted, never hidden. */
  excludedFleetIds: number[];
  /** Scheduled checks, smallest first. Doing a bigger check also resets the smaller ones. */
  checks: CheckRule[];
  /** Most severe first; the first match wins. */
  hardLanding: HardLandingRule[];
  /** Marks our line in the aircraft's internal remarks. */
  tag: string;
}

export interface MxPeriod {
  reason: string;
  from: string;
  until: string;
  pirepId?: number;
  /** Was the aircraft already hidden by staff before we hid it? Then we leave it hidden on release. */
  wasHidden: boolean;
  /** False when started in dry run (nothing was changed in vAMSYS). */
  applied: boolean;
}

export interface AircraftState {
  id: number;
  fleetId: number;
  registration?: string;
  /** Hours / cycles since each check (by check name). */
  since: Record<string, { hours: number; cycles: number }>;
  inMx?: MxPeriod;
  history: MxPeriod[];
}

export interface MxEvent {
  kind: "start" | "extend" | "release";
  aircraftId: number;
  registration?: string;
  reason: string;
  until: string;
  pirepId?: number;
  dryRun: boolean;
  at: string;
}

const SKIP_STATUSES = new Set(["rejected", "invalidated", "invalid"]);
const key = (id: number) => `mx:ac:${id}`;
const ACTIVE = "mx:active";

export async function loadState(store: Store, id: number): Promise<AircraftState | null> {
  const raw = await store.get(key(id));
  return raw ? (JSON.parse(raw) as AircraftState) : null;
}
const saveState = (store: Store, s: AircraftState) => store.put(key(s.id), JSON.stringify(s));

async function activeIds(store: Store): Promise<number[]> {
  return JSON.parse((await store.get(ACTIVE)) ?? "[]") as number[];
}

const fmtUtc = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + "Z";

function withTag(remarks: string | null, tag: string, line: string | null): string | null {
  const kept = (remarks ?? "").split("\n").filter((l) => !l.startsWith(tag));
  if (line) kept.push(`${tag} ${line}`);
  const out = kept.join("\n").trim();
  return out.length ? out : null;
}

/** Which trigger (if any) this PIREP causes. Pure, for testing. */
export function evaluate(state: AircraftState, p: PirepSummary, cfg: MxConfig): { reason: string; durationH: number } | null {
  const hard = cfg.hardLanding.find(
    (r) => (p.landing_rate != null && p.landing_rate <= r.rateFpm) || (p.landing_g != null && p.landing_g >= r.g),
  );
  // The biggest due check wins.
  const due = [...cfg.checks].reverse().find((c) => {
    const s = state.since[c.name] ?? { hours: 0, cycles: 0 };
    return s.hours >= c.everyHours || s.cycles >= c.everyCycles;
  });
  const cands = [
    hard && { reason: `${hard.name} (${p.landing_rate ?? "?"} fpm / ${p.landing_g ?? "?"} g)`, durationH: hard.durationH },
    due && { reason: due.name, durationH: due.durationH },
  ].filter(Boolean) as { reason: string; durationH: number }[];
  if (!cands.length) return null;
  // Both at once: one maintenance period covering the longer one.
  const longest = cands.reduce((a, b) => (b.durationH > a.durationH ? b : a));
  return { reason: cands.map((c) => c.reason).join(" + "), durationH: longest.durationH };
}

/** Count a newly filed PIREP and start maintenance if it triggers one. */
export async function onPirep(
  api: VamsysPort,
  store: Store,
  cfg: MxConfig,
  p: PirepSummary,
  opts: { dryRun: boolean; now?: Date; heldElsewhere?: (id: number) => Promise<boolean> },
): Promise<MxEvent | null> {
  if (SKIP_STATUSES.has(p.status) || p.type === "claim") return null;
  if (!p.aircraft_id || !p.fleet_id || cfg.excludedFleetIds.includes(p.fleet_id)) return null;
  const now = opts.now ?? new Date();

  const state: AircraftState = (await loadState(store, p.aircraft_id)) ?? {
    id: p.aircraft_id,
    fleetId: p.fleet_id,
    since: {},
    history: [],
  };
  state.fleetId = p.fleet_id;
  const hours = Math.max(0, (p.flight_length ?? 0) / 3600);
  for (const c of cfg.checks) {
    const s = (state.since[c.name] ??= { hours: 0, cycles: 0 });
    s.hours += hours;
    s.cycles += 1;
  }

  const trig = evaluate(state, p, cfg);
  if (!trig) {
    await saveState(store, state);
    return null;
  }

  // Reset the counters of the check(s) being done, and of every smaller check.
  const doneIdx = cfg.checks.reduce((acc, c, i) => (trig.reason.includes(c.name) ? i : acc), -1);
  for (let i = 0; i <= doneIdx; i++) state.since[cfg.checks[i]!.name] = { hours: 0, cycles: 0 };

  const until = new Date(now.getTime() + trig.durationH * 3600_000);
  let kind: MxEvent["kind"] = "start";
  let ac: Aircraft | null = null;
  if (state.inMx && new Date(state.inMx.until) >= now) {
    kind = "extend";
    if (until > new Date(state.inMx.until)) state.inMx.until = until.toISOString();
    state.inMx.reason = `${state.inMx.reason}; ${trig.reason}`;
  } else {
    ac = await api.getAircraft(p.fleet_id, p.aircraft_id);
    state.registration = ac.registration;
    state.inMx = {
      reason: trig.reason,
      from: now.toISOString(),
      until: until.toISOString(),
      pirepId: p.id,
      // Hidden by AOG is not "hidden by staff".
      wasHidden: ac.hide_in_phoenix && !((await opts.heldElsewhere?.(p.aircraft_id)) ?? false),
      applied: !opts.dryRun,
    };
  }

  if (!opts.dryRun) {
    ac ??= await api.getAircraft(p.fleet_id, p.aircraft_id);
    await api.updateAircraft(p.fleet_id, p.aircraft_id, {
      hide_in_phoenix: true,
      internal_remarks: withTag(ac.internal_remarks, cfg.tag, `${state.inMx.reason} until ${fmtUtc(new Date(state.inMx.until))} (auto)`),
    });
    state.inMx.applied = true;
  }
  await saveState(store, state);
  const act = await activeIds(store);
  if (!act.includes(state.id)) await store.put(ACTIVE, JSON.stringify([...act, state.id]));

  return {
    kind,
    aircraftId: state.id,
    registration: state.registration,
    reason: state.inMx.reason,
    until: state.inMx.until,
    pirepId: p.id,
    dryRun: opts.dryRun,
    at: now.toISOString(),
  };
}

/** Show aircraft again whose maintenance has ended. */
export async function releaseDue(
  api: VamsysPort,
  store: Store,
  cfg: MxConfig,
  opts: { dryRun: boolean; now?: Date; force?: number[]; heldElsewhere?: (id: number) => Promise<boolean> },
): Promise<MxEvent[]> {
  const now = opts.now ?? new Date();
  const events: MxEvent[] = [];
  const keep: number[] = [];
  for (const id of await activeIds(store)) {
    const state = await loadState(store, id);
    if (!state?.inMx) continue;
    const forced = opts.force?.includes(id) ?? false;
    if (!forced && new Date(state.inMx.until) > now) {
      keep.push(id);
      continue;
    }
    try {
      // Only touch vAMSYS if we actually hid it (not a dry-run period) and we are live now.
      if (state.inMx.applied && !opts.dryRun) {
        const ac = await api.getAircraft(state.fleetId, id);
        const stillHeld = (await opts.heldElsewhere?.(id)) ?? false; // e.g. AOG
        await api.updateAircraft(state.fleetId, id, {
          ...(stillHeld ? {} : { hide_in_phoenix: state.inMx.wasHidden }),
          internal_remarks: withTag(ac.internal_remarks, cfg.tag, null),
        });
      }
    } catch {
      keep.push(id); // try again next cycle
      continue;
    }
    events.push({
      kind: "release",
      aircraftId: id,
      registration: state.registration,
      reason: state.inMx.reason,
      until: state.inMx.until,
      pirepId: state.inMx.pirepId,
      dryRun: opts.dryRun,
      at: now.toISOString(),
    });
    state.history = [state.inMx, ...state.history].slice(0, 10);
    delete state.inMx;
    await saveState(store, state);
  }
  if (events.length) await store.put(ACTIVE, JSON.stringify(keep)); // only write when something changed
  return events;
}

/** Aircraft currently in maintenance (for the status page). */
export async function activeList(store: Store): Promise<AircraftState[]> {
  const out: AircraftState[] = [];
  for (const id of await activeIds(store)) {
    const s = await loadState(store, id);
    if (s?.inMx) out.push(s);
  }
  return out.sort((a, b) => a.inMx!.until.localeCompare(b.inMx!.until));
}

/** Is this aircraft currently in maintenance? (used by the AOG module) */
export async function inMaintenance(store: Store, id: number): Promise<boolean> {
  const s = await loadState(store, id);
  return Boolean(s?.inMx);
}
