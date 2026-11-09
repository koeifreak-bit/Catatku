/**
 * AOG (aircraft on ground) from REAL-world movement.
 *
 * Every 15 minutes the Worker asks a free ADS-B feed (adsb.lol) which of our aircraft (by ICAO hex,
 * stored in vAMSYS) are airborne. If the real aircraft has not been seen flying for `aogAfterDays`,
 * it is declared AOG and hidden in Phoenix until the real aircraft is seen flying again.
 */
import type { Store } from "./process";
import type { VamsysPort } from "./vamsys";

export interface AogConfig {
  aogAfterDays: number;
  excludedFleetIds: number[];
  tag: string;
  /** Feed must have been healthy this long before anything is declared AOG (protects against outages). */
  feedHealthyForDays: number;
  /** Treat as flying when not "ground" and at least this fast. */
  minAirborneKts: number;
}

export interface TrackedAircraft {
  id: number;
  fleetId: number;
  registration: string;
  /** Empty when vAMSYS has no hex code (not tracked by ADS-B, but still shown and maintained). */
  hex: string;
  fleetCode?: string;
  fleetName?: string;
}

export interface AdsbTarget {
  hex: string;
  alt_baro?: number | "ground";
  gs?: number;
  flight?: string;
}

export interface AdsbFeed {
  /** Aircraft currently visible for these hexes. Throws on feed errors. */
  lookup(hexes: string[]): Promise<AdsbTarget[]>;
}

export interface AogState {
  /** aircraftId -> last time the real aircraft was seen airborne (ISO). */
  lastAirborne: Record<string, string>;
  /** aircraftId -> AOG period. */
  aog: Record<
    string,
    {
      since: string;
      lastFlown: string;
      wasHidden: boolean;
      applied: boolean;
      registration: string;
      fleetId: number;
      /** Declared by staff (e.g. parked/stored per planespotters). Only staff can lift it. */
      manual?: boolean;
      note?: string;
      /** Set when the real aircraft is seen flying while manually parked (staff may want to unpark). */
      seenFlyingAt?: string;
    }
  >;
  /** Aircraft actually seen airborne at least once (others only have the tracking-start time). */
  seen?: Record<string, 1>;
  /** Start of the current unbroken healthy-feed period. */
  feedHealthySince: string | null;
  lastPoll: string | null;
}

export interface AogEvent {
  kind: "aog" | "release";
  aircraftId: number;
  registration: string;
  lastFlown: string;
  callsign?: string;
  dryRun: boolean;
  at: string;
}

const KEY = "aog:state";
const DAY = 86_400_000;

export const emptyState = (): AogState => ({ lastAirborne: {}, aog: {}, feedHealthySince: null, lastPoll: null });

function withTag(remarks: string | null, tag: string, line: string | null): string | null {
  const kept = (remarks ?? "").split("\n").filter((l) => !l.startsWith(tag));
  if (line) kept.push(`${tag} ${line}`);
  const out = kept.join("\n").trim();
  return out.length ? out : null;
}

export const isAirborne = (t: AdsbTarget, cfg: AogConfig) =>
  t.alt_baro !== "ground" && t.alt_baro != null && (t.gs ?? 0) >= cfg.minAirborneKts;

export class AdsbLol implements AdsbFeed {
  constructor(private fetchFn: typeof fetch = (i, init) => fetch(i, init)) {}
  async lookup(hexes: string[]) {
    const out: AdsbTarget[] = [];
    for (let i = 0; i < hexes.length; i += 40) {
      const res = await this.fetchFn(`https://api.adsb.lol/v2/hex/${hexes.slice(i, i + 40).join(",")}`, {
        headers: { Accept: "application/json", "User-Agent": "ijv-vamsys-tdz/1.0 (virtual airline fleet status)" },
      });
      if (!res.ok) throw new Error(`adsb.lol ${res.status}`);
      out.push(...(((await res.json()) as { ac?: AdsbTarget[] }).ac ?? []));
    }
    return out;
  }
}

/**
 * One AOG poll. `inMaintenance(id)` says whether the maintenance module also holds the aircraft,
 * in which case releasing AOG must not show it yet.
 */
export async function pollAog(
  api: VamsysPort,
  feed: AdsbFeed,
  store: Store,
  cfg: AogConfig,
  aircraft: TrackedAircraft[],
  opts: { dryRun: boolean; now?: Date; inMaintenance?: (id: number) => Promise<boolean> },
): Promise<AogEvent[]> {
  const now = opts.now ?? new Date();
  const raw = await store.get(KEY);
  const state: AogState = raw ? JSON.parse(raw) : emptyState();
  const before = JSON.stringify(state);
  const events: AogEvent[] = [];
  const tracked = aircraft.filter((a) => a.hex && !cfg.excludedFleetIds.includes(a.fleetId));

  let targets: AdsbTarget[];
  try {
    targets = await feed.lookup(tracked.map((a) => a.hex.toLowerCase()));
  } catch {
    state.feedHealthySince = null; // outage: restart the safety clock
    await store.put(KEY, JSON.stringify(state));
    return [];
  }
  // A whole fleet invisible at once means the feed is broken, not that everything is grounded.
  if (targets.length === 0 && tracked.length >= 20) {
    if (state.feedHealthySince !== null) {
      state.feedHealthySince = null;
      await store.put(KEY, JSON.stringify(state));
    }
    return [];
  }
  state.feedHealthySince ??= now.toISOString();
  state.lastPoll = now.toISOString();

  const byHex = new Map(tracked.map((a) => [a.hex.toLowerCase(), a]));
  const flyingNow = new Map<number, AdsbTarget>();
  for (const t of targets) {
    const a = byHex.get(t.hex.toLowerCase());
    if (a && isAirborne(t, cfg)) flyingNow.set(a.id, t);
  }

  const feedOk = now.getTime() - new Date(state.feedHealthySince).getTime() >= cfg.feedHealthyForDays * DAY;

  for (const a of tracked) {
    const k = String(a.id);
    // First time we track an aircraft: give it the full grace period.
    state.lastAirborne[k] ??= now.toISOString();
    const flying = flyingNow.get(a.id);
    if (flying) {
      if (!state.seen?.[k]) (state.seen ??= {})[k] = 1;
      // Store with 1 h resolution to save KV writes.
      if (now.getTime() - new Date(state.lastAirborne[k]!).getTime() > 3600_000) state.lastAirborne[k] = now.toISOString();
      const held = state.aog[k];
      if (held?.manual) {
        // Staff-declared AOG is never lifted automatically; just flag it on the status page.
        if (!held.seenFlyingAt) held.seenFlyingAt = now.toISOString();
        continue;
      }
      if (held) {
        const mx = (await opts.inMaintenance?.(a.id)) ?? false;
        if (held.applied && !opts.dryRun) {
          const ac = await api.getAircraft(a.fleetId, a.id);
          await api.updateAircraft(a.fleetId, a.id, {
            ...(held.wasHidden || mx ? {} : { hide_in_phoenix: false }),
            internal_remarks: withTag(ac.internal_remarks, cfg.tag, null),
          });
        }
        delete state.aog[k];
        state.lastAirborne[k] = now.toISOString();
        events.push({ kind: "release", aircraftId: a.id, registration: a.registration, lastFlown: now.toISOString(), callsign: flying.flight?.trim(), dryRun: opts.dryRun, at: now.toISOString() });
      }
      continue;
    }
    const last = new Date(state.lastAirborne[k]!);
    if (!state.aog[k] && feedOk && now.getTime() - last.getTime() >= cfg.aogAfterDays * DAY) {
      const ac = await api.getAircraft(a.fleetId, a.id);
      if (!opts.dryRun) {
        await api.updateAircraft(a.fleetId, a.id, {
          hide_in_phoenix: true,
          internal_remarks: withTag(ac.internal_remarks, cfg.tag, `Real aircraft not flown since ${last.toISOString().slice(0, 10)} (auto)`),
        });
      }
      // Hidden by maintenance is not "hidden by staff".
      const mxHolds = (await opts.inMaintenance?.(a.id)) ?? false;
      state.aog[k] = { since: now.toISOString(), lastFlown: last.toISOString(), wasHidden: ac.hide_in_phoenix && !mxHolds, applied: !opts.dryRun, registration: a.registration, fleetId: a.fleetId };
      events.push({ kind: "aog", aircraftId: a.id, registration: a.registration, lastFlown: last.toISOString(), dryRun: opts.dryRun, at: now.toISOString() });
    }
  }

  // lastPoll alone changing is only worth a KV write once an hour.
  const prev = JSON.parse(before) as AogState;
  const { lastPoll: prevPoll, ...b1 } = prev;
  const { lastPoll: _b, ...b2 } = state;
  const pollStale = !prevPoll || now.getTime() - new Date(prevPoll).getTime() >= 3600_000;
  if (JSON.stringify(b1) !== JSON.stringify(b2) || !raw || pollStale) await store.put(KEY, JSON.stringify(state));
  else state.lastPoll = prevPoll;
  return events;
}

export interface ParkResult {
  parked: string[];
  alreadyAog: string[];
  notFound: string[];
  /** Not done yet because of the per-request limit; call again with these. */
  remaining: string[];
}

/** Cloudflare free plan: 50 outgoing requests per invocation; each park/unpark uses 2. */
export const PARK_BATCH = 12;

const normReg = (r: string) => {
  const x = r.trim().toUpperCase();
  return x.startsWith("PK-") ? x : x.startsWith("PK") ? `PK-${x.slice(2)}` : `PK-${x}`;
};

/** Staff: declare aircraft AOG immediately (e.g. parked/stored per planespotters). */
export async function park(
  api: VamsysPort,
  store: Store,
  cfg: AogConfig,
  aircraft: TrackedAircraft[],
  regs: string[],
  opts: {
    dryRun: boolean;
    note?: string;
    now?: Date;
    inMaintenance?: (id: number) => Promise<boolean>;
    /** Known original "hidden by staff" flags (e.g. to recover from an interrupted run). */
    wasHiddenOverride?: Record<string, boolean>;
    limit?: number;
  },
): Promise<ParkResult & { events: AogEvent[] }> {
  const now = opts.now ?? new Date();
  const state = await aogState(store);
  const byReg = new Map(aircraft.map((a) => [a.registration.toUpperCase(), a]));
  const res: ParkResult & { events: AogEvent[] } = { parked: [], alreadyAog: [], notFound: [], remaining: [], events: [] };
  const limit = opts.limit ?? PARK_BATCH;
  const override = Object.fromEntries(Object.entries(opts.wasHiddenOverride ?? {}).map(([k, v]) => [normReg(k), v]));
  for (const reg of [...new Set(regs.map(normReg))]) {
    if (res.parked.length >= limit) {
      res.remaining.push(reg);
      continue;
    }
    const a = byReg.get(reg);
    if (!a || cfg.excludedFleetIds.includes(a.fleetId)) {
      res.notFound.push(reg);
      continue;
    }
    const k = String(a.id);
    const existing = state.aog[k];
    if (existing?.manual) {
      res.alreadyAog.push(reg);
      continue;
    }
    const line = `Parked/stored, declared AOG by staff${opts.note ? `: ${opts.note}` : ""} (since ${now.toISOString().slice(0, 10)})`;
    const ac = await api.getAircraft(a.fleetId, a.id);
    if (!opts.dryRun) {
      await api.updateAircraft(a.fleetId, a.id, { hide_in_phoenix: true, internal_remarks: withTag(ac.internal_remarks, cfg.tag, line) });
    }
    const mxHolds = (await opts.inMaintenance?.(a.id)) ?? false;
    state.aog[k] = {
      since: existing?.since ?? now.toISOString(),
      lastFlown: existing?.lastFlown ?? state.lastAirborne[k] ?? now.toISOString(),
      // If ADS-B-AOG already hid it, keep its original "was hidden by staff" flag.
      wasHidden: reg in override ? override[reg]! : existing ? existing.wasHidden : ac.hide_in_phoenix && !mxHolds,
      applied: !opts.dryRun || Boolean(existing?.applied),
      registration: a.registration,
      fleetId: a.fleetId,
      manual: true,
      note: opts.note,
    };
    // Save after every aircraft, so an interrupted request never leaves hidden-but-unrecorded aircraft.
    await store.put(KEY, JSON.stringify(state));
    res.parked.push(reg);
    res.events.push({ kind: "aog", aircraftId: a.id, registration: a.registration, lastFlown: state.aog[k]!.lastFlown, dryRun: opts.dryRun, at: now.toISOString() });
  }
  return res;
}

/** Staff: lift a staff-declared AOG (the aircraft is shown again unless maintenance or staff still hide it). */
export async function unpark(
  api: VamsysPort,
  store: Store,
  cfg: AogConfig,
  aircraft: TrackedAircraft[],
  regs: string[],
  opts: { dryRun: boolean; now?: Date; inMaintenance?: (id: number) => Promise<boolean>; limit?: number },
): Promise<{ released: string[]; notParked: string[]; remaining: string[]; events: AogEvent[] }> {
  const now = opts.now ?? new Date();
  const state = await aogState(store);
  const byReg = new Map(aircraft.map((a) => [a.registration.toUpperCase(), a]));
  const out = { released: [] as string[], notParked: [] as string[], remaining: [] as string[], events: [] as AogEvent[] };
  for (const reg of [...new Set(regs.map(normReg))]) {
    if (out.released.length >= (opts.limit ?? PARK_BATCH)) {
      out.remaining.push(reg);
      continue;
    }
    const a = byReg.get(reg);
    const held = a && state.aog[String(a.id)];
    if (!a || !held?.manual) {
      out.notParked.push(reg);
      continue;
    }
    const mx = (await opts.inMaintenance?.(a.id)) ?? false;
    if (held.applied && !opts.dryRun) {
      const ac = await api.getAircraft(a.fleetId, a.id);
      await api.updateAircraft(a.fleetId, a.id, {
        ...(held.wasHidden || mx ? {} : { hide_in_phoenix: false }),
        internal_remarks: withTag(ac.internal_remarks, cfg.tag, null),
      });
    }
    delete state.aog[String(a.id)];
    // Fresh 3-day ADS-B grace period from now.
    state.lastAirborne[String(a.id)] = now.toISOString();
    await store.put(KEY, JSON.stringify(state));
    out.released.push(reg);
    out.events.push({ kind: "release", aircraftId: a.id, registration: a.registration, lastFlown: held.lastFlown, dryRun: opts.dryRun, at: now.toISOString() });
  }
  return out;
}

export async function aogState(store: Store): Promise<AogState> {
  const raw = await store.get(KEY);
  return raw ? JSON.parse(raw) : emptyState();
}

/** All non-historic aircraft from vAMSYS (cached by the caller). Those without hex are included but not ADS-B tracked. */
export async function loadTrackedAircraft(
  api: VamsysPort & {
    listFleets(): Promise<{ id: number; code: string; name: string }[]>;
    listAircraft(fleetId: number): Promise<{ id: number; fleet_id: number; registration: string; hexcode: string | null }[]>;
  },
  excludedFleetIds: number[],
): Promise<TrackedAircraft[]> {
  const out: TrackedAircraft[] = [];
  for (const f of await api.listFleets()) {
    if (excludedFleetIds.includes(f.id)) continue;
    for (const a of await api.listAircraft(f.id)) {
      out.push({ id: a.id, fleetId: a.fleet_id ?? f.id, registration: a.registration, hex: (a.hexcode ?? "").toLowerCase(), fleetCode: f.code, fleetName: f.name });
    }
  }
  return out;
}
