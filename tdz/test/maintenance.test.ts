import { beforeEach, describe, expect, it } from "vitest";
import { activeList, evaluate, loadState, onPirep, releaseDue, type MxConfig } from "../src/maintenance";
import { MX_CONFIG } from "../src/maintenance-config";
import type { Store } from "../src/process";
import type { Aircraft, AircraftPatch, PirepSummary, VamsysPort } from "../src/vamsys";

class MemStore implements Store {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
}

class FakeApi implements Partial<VamsysPort> {
  aircraft = new Map<number, Aircraft>();
  updates: [number, AircraftPatch][] = [];
  async getAircraft(fleetId: number, id: number) {
    if (!this.aircraft.has(id)) this.aircraft.set(id, { id, fleet_id: fleetId, registration: `PK-${id}`, hide_in_phoenix: false, internal_remarks: null });
    return { ...this.aircraft.get(id)! };
  }
  async updateAircraft(_f: number, id: number, patch: AircraftPatch) {
    this.updates.push([id, patch]);
    Object.assign(this.aircraft.get(id)!, patch);
  }
}

const cfg: MxConfig = MX_CONFIG;
const B738 = 19438, MD11 = 26882;
let n = 1000;
const pirep = (o: Partial<PirepSummary> = {}): PirepSummary => ({
  id: n++, status: "accepted", type: "scheduled", callsign: "GIA1", bonus_sum: 0,
  aircraft_id: 1, fleet_id: B738, flight_length: 2 * 3600, landing_rate: -150, landing_g: 1.1, ...o,
});
const T0 = new Date("2026-11-09T00:00:00Z");
const h = (hours: number) => new Date(T0.getTime() + hours * 3600_000);

let api: FakeApi, store: MemStore;
const live = { dryRun: false, now: T0 };
beforeEach(() => { api = new FakeApi(); store = new MemStore(); n = 1000; });
const run = (p: PirepSummary, o = live) => onPirep(api as unknown as VamsysPort, store, cfg, p, o);
const release = (o: { dryRun: boolean; now?: Date; force?: number[] }) => releaseDue(api as unknown as VamsysPort, store, cfg, o);

describe("hard landings", () => {
  it("normal landing: counts hours/cycles, nothing hidden", async () => {
    expect(await run(pirep())).toBeNull();
    const s = await loadState(store, 1);
    expect(s!.since["A-check"]).toEqual({ hours: 2, cycles: 1 });
    expect(api.updates).toEqual([]);
  });

  it("-650 fpm → 24 h inspection, aircraft hidden with a remark", async () => {
    const e = await run(pirep({ landing_rate: -650 }));
    expect(e).toMatchObject({ kind: "start", registration: "PK-1", until: h(24).toISOString() });
    expect(api.aircraft.get(1)).toMatchObject({ hide_in_phoenix: true });
    expect(api.aircraft.get(1)!.internal_remarks).toMatch(/^\[MX-AUTO\] Hard landing inspection \(-650 fpm \/ 1.1 g\) until 2026-11-10 00:00Z \(auto\)$/);
  });

  it("-850 fpm or 2.3 g → severe, 72 h", async () => {
    expect(await run(pirep({ landing_rate: -850 }))).toMatchObject({ until: h(72).toISOString() });
    expect(await run(pirep({ aircraft_id: 2, landing_g: 2.3 }))).toMatchObject({ reason: expect.stringContaining("Severe") });
  });

  it("2.0 g alone triggers the normal inspection, 1.9 g does not", () => {
    expect(evaluate({ id: 1, fleetId: B738, since: {}, history: [] }, pirep({ landing_g: 2.0 }), cfg)).toMatchObject({ durationH: 24 });
    expect(evaluate({ id: 1, fleetId: B738, since: {}, history: [] }, pirep({ landing_g: 1.9 }), cfg)).toBeNull();
  });
});

describe("scheduled checks", () => {
  it("A-check after 50 flight hours", async () => {
    for (let i = 0; i < 24; i++) expect(await run(pirep())).toBeNull(); // 48 h
    expect(await run(pirep())).toMatchObject({ reason: "A-check", until: h(24).toISOString() }); // 50 h
    expect((await loadState(store, 1))!.since["A-check"]).toEqual({ hours: 0, cycles: 0 });
    expect((await loadState(store, 1))!.since["C-check"]).toEqual({ hours: 50, cycles: 25 });
  });

  it("A-check after 40 cycles of short hops", async () => {
    for (let i = 0; i < 39; i++) await run(pirep({ flight_length: 1800 }));
    expect(await run(pirep({ flight_length: 1800 }))).toMatchObject({ reason: "A-check" });
  });

  it("C-check wins over A-check and resets both", async () => {
    await store.put("mx:ac:1", JSON.stringify({ id: 1, fleetId: B738, since: { "A-check": { hours: 49, cycles: 1 }, "C-check": { hours: 499, cycles: 1 } }, history: [] }));
    const e = await run(pirep());
    expect(e).toMatchObject({ reason: "C-check", until: h(120).toISOString() });
    const s = (await loadState(store, 1))!;
    expect(s.since).toEqual({ "A-check": { hours: 0, cycles: 0 }, "C-check": { hours: 0, cycles: 0 } });
  });
});

describe("exclusions and dry run", () => {
  it("historic fleets are ignored completely", async () => {
    expect(await run(pirep({ fleet_id: MD11, landing_rate: -1200 }))).toBeNull();
    expect(await loadState(store, 1)).toBeNull();
  });

  it("rejected PIREPs and claims don't count", async () => {
    expect(await run(pirep({ status: "rejected", landing_rate: -900 }))).toBeNull();
    expect(await run(pirep({ type: "claim", landing_rate: -900 }))).toBeNull();
    expect(await loadState(store, 1)).toBeNull();
  });

  it("dry run tracks maintenance but never changes vAMSYS", async () => {
    const e = await run(pirep({ landing_rate: -700 }), { dryRun: true, now: T0 });
    expect(e).toMatchObject({ kind: "start", dryRun: true });
    expect(api.updates).toEqual([]);
    expect(await release({ dryRun: true, now: h(25) })).toHaveLength(1);
    expect(api.updates).toEqual([]);
  });
});

describe("release", () => {
  it("shows the aircraft again after the check and removes only our remark", async () => {
    api.aircraft.set(1, { id: 1, fleet_id: B738, registration: "PK-GFF", hide_in_phoenix: false, internal_remarks: "Staff note: new seats" });
    await run(pirep({ landing_rate: -650 }));
    expect(api.aircraft.get(1)!.internal_remarks).toContain("Staff note: new seats\n[MX-AUTO]");
    expect(await release({ dryRun: false, now: h(23) })).toEqual([]); // not yet
    const ev = await release({ dryRun: false, now: h(24) });
    expect(ev).toMatchObject([{ kind: "release", registration: "PK-GFF" }]);
    expect(api.aircraft.get(1)).toMatchObject({ hide_in_phoenix: false, internal_remarks: "Staff note: new seats" });
    expect(await activeList(store)).toEqual([]);
    expect((await loadState(store, 1))!.history).toHaveLength(1);
  });

  it("an aircraft staff had already hidden stays hidden after release", async () => {
    api.aircraft.set(1, { id: 1, fleet_id: B738, registration: "PK-GUM", hide_in_phoenix: true, internal_remarks: null });
    await run(pirep({ landing_rate: -650 }));
    await release({ dryRun: false, now: h(25) });
    expect(api.aircraft.get(1)).toMatchObject({ hide_in_phoenix: true, internal_remarks: null });
  });

  it("a second trigger during maintenance extends it instead of starting a new one", async () => {
    await run(pirep({ landing_rate: -650 }));
    const e = await run(pirep({ landing_rate: -900 }), { dryRun: false, now: h(2) });
    expect(e).toMatchObject({ kind: "extend", until: h(74).toISOString() });
    expect(await activeList(store)).toHaveLength(1);
  });

  it("staff can release early (force)", async () => {
    await run(pirep({ landing_rate: -650 }));
    expect(await release({ dryRun: false, now: h(1), force: [1] })).toHaveLength(1);
    expect(api.aircraft.get(1)!.hide_in_phoenix).toBe(false);
  });

  it("a release that fails (API error) is retried next cycle", async () => {
    await run(pirep({ landing_rate: -650 }));
    const upd = api.updateAircraft.bind(api);
    api.updateAircraft = async () => { throw new Error("503"); };
    expect(await release({ dryRun: false, now: h(25) })).toEqual([]);
    api.updateAircraft = upd;
    expect(await release({ dryRun: false, now: h(30) })).toHaveLength(1);
  });
});
