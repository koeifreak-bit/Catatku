import { beforeEach, describe, expect, it } from "vitest";
import { aogState, pollAog, type AdsbFeed, type AdsbTarget, type TrackedAircraft } from "../src/aog";
import { onPirep, releaseDue } from "../src/maintenance";
import { AOG_CONFIG as cfg, MX_CONFIG } from "../src/maintenance-config";
import type { Store } from "../src/process";
import type { Aircraft, AircraftPatch, VamsysPort } from "../src/vamsys";

class MemStore implements Store {
  m = new Map<string, string>();
  writes = 0;
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.writes++; this.m.set(k, v); }
}
class FakeApi {
  aircraft = new Map<number, Aircraft>();
  updates: [number, AircraftPatch][] = [];
  async getAircraft(fleetId: number, id: number) {
    if (!this.aircraft.has(id)) this.aircraft.set(id, { id, fleet_id: fleetId, registration: `PK-${id}`, hide_in_phoenix: false, internal_remarks: null });
    return { ...this.aircraft.get(id)! };
  }
  async updateAircraft(_f: number, id: number, patch: AircraftPatch) { this.updates.push([id, patch]); Object.assign(this.aircraft.get(id)!, patch); }
}
class FakeFeed implements AdsbFeed {
  flying = new Set<string>();
  down = false;
  async lookup(hexes: string[]): Promise<AdsbTarget[]> {
    if (this.down) throw new Error("503");
    return hexes.filter((h) => this.flying.has(h)).map((hex) => ({ hex, alt_baro: 35000, gs: 450, flight: "GIA1" }));
  }
}

const B738 = 19438, MD11 = 26882;
// 25 tracked aircraft so the "whole fleet invisible = feed broken" guard is realistic; #1 is the one we watch.
const fleet: TrackedAircraft[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, fleetId: B738, registration: `PK-G${i + 1}`, hex: `8a00${(i + 1).toString(16).padStart(2, "0")}` }));
const T0 = new Date("2026-11-09T00:00:00Z");
const d = (days: number) => new Date(T0.getTime() + days * 86_400_000);

let api: FakeApi, feed: FakeFeed, store: MemStore;
beforeEach(() => {
  api = new FakeApi(); feed = new FakeFeed(); store = new MemStore();
  for (const a of fleet.slice(1)) feed.flying.add(a.hex); // everyone else keeps flying
});
const poll = (now: Date, dryRun = false, list = fleet) =>
  pollAog(api as unknown as VamsysPort, feed, store, cfg, list, { dryRun, now, inMaintenance: async (id) => (await import("../src/maintenance")).inMaintenance(store, id) });

describe("AOG from real-world ADS-B", () => {
  it("an aircraft not seen flying for 3 days is declared AOG and hidden", async () => {
    expect(await poll(T0)).toEqual([]);
    expect(await poll(d(2.9))).toEqual([]);
    const ev = await poll(d(3.01));
    expect(ev).toMatchObject([{ kind: "aog", aircraftId: 1, registration: "PK-G1" }]);
    expect(api.aircraft.get(1)).toMatchObject({ hide_in_phoenix: true, internal_remarks: "[AOG-AUTO] Real aircraft not flown since 2026-11-09 (auto)" });
  });

  it("is shown again as soon as the real aircraft flies", async () => {
    await poll(T0); await poll(d(3.01));
    feed.flying.add(fleet[0]!.hex);
    expect(await poll(d(3.5))).toMatchObject([{ kind: "release", aircraftId: 1, callsign: "GIA1" }]);
    expect(api.aircraft.get(1)).toMatchObject({ hide_in_phoenix: false, internal_remarks: null });
    expect(Object.keys((await aogState(store)).aog)).toEqual([]);
  });

  it("an aircraft that keeps flying is never AOG", async () => {
    feed.flying.add(fleet[0]!.hex);
    for (let day = 0; day <= 10; day += 0.5) expect(await poll(d(day))).toEqual([]);
  });

  it("ground targets and taxiing don't count as flying", async () => {
    await poll(T0);
    feed.lookup = async (h) => h.map((hex) => (hex === fleet[0]!.hex ? { hex, alt_baro: "ground" as const, gs: 15 } : { hex, alt_baro: 30000, gs: 400 }));
    expect(await poll(d(3.01))).toMatchObject([{ kind: "aog", aircraftId: 1 }]);
  });

  it("feed outage: nothing is declared AOG, and the 3-day safety clock restarts", async () => {
    await poll(T0);
    feed.down = true;
    expect(await poll(d(3.5))).toEqual([]);
    feed.down = false;
    expect(await poll(d(4))).toEqual([]); // feed only healthy since day 4
    expect(await poll(d(7.01))).toMatchObject([{ kind: "aog", aircraftId: 1 }]);
  });

  it("whole fleet invisible at once is treated as a broken feed", async () => {
    await poll(T0);
    feed.flying.clear();
    expect(await poll(d(3.5))).toEqual([]);
  });

  it("historic fleets and aircraft without hex are ignored", async () => {
    const list = [...fleet, { id: 99, fleetId: MD11, registration: "PK-GIM", hex: "8a0999" }, { id: 98, fleetId: B738, registration: "PK-NOHEX", hex: "" }];
    await poll(T0, false, list);
    const ev = await poll(d(3.01), false, list);
    expect(ev.map((e) => e.aircraftId)).toEqual([1]);
  });

  it("dry run records AOG but never changes vAMSYS", async () => {
    await poll(T0, true);
    expect(await poll(d(3.01), true)).toMatchObject([{ kind: "aog", dryRun: true }]);
    expect(api.updates).toEqual([]);
  });

  it("an aircraft staff had already hidden stays hidden after AOG ends", async () => {
    api.aircraft.set(1, { id: 1, fleet_id: B738, registration: "PK-G1", hide_in_phoenix: true, internal_remarks: null });
    await poll(T0); await poll(d(3.01));
    feed.flying.add(fleet[0]!.hex);
    await poll(d(3.5));
    expect(api.aircraft.get(1)!.hide_in_phoenix).toBe(true);
  });

  it("does not write to KV on every poll when nothing changed", async () => {
    feed.flying.add(fleet[0]!.hex);
    await poll(T0);
    const w = store.writes;
    for (let i = 1; i <= 3; i++) await poll(new Date(T0.getTime() + i * 15 * 60_000)); // 45 min
    expect(store.writes).toBe(w);
  });
});

describe("AOG and maintenance together", () => {
  const mx = (p: Partial<Parameters<typeof onPirep>[3]>, now: Date) =>
    onPirep(api as unknown as VamsysPort, store, MX_CONFIG, { id: 1, status: "accepted", type: "scheduled", callsign: "X", bonus_sum: 0, aircraft_id: 1, fleet_id: B738, flight_length: 3600, landing_rate: -700, landing_g: 1.2, ...p }, { dryRun: false, now, heldElsewhere: async (id) => Boolean((await aogState(store)).aog[String(id)]) });
  const mxRelease = (now: Date) =>
    releaseDue(api as unknown as VamsysPort, store, MX_CONFIG, { dryRun: false, now, heldElsewhere: async (id) => Boolean((await aogState(store)).aog[String(id)]) });

  it("AOG then maintenance: shown again only once BOTH are over", async () => {
    await poll(T0); await poll(d(3.01)); // AOG hides it
    await mx({}, d(3.1)); // maintenance until d(4.1)
    feed.flying.add(fleet[0]!.hex);
    await poll(d(3.5)); // AOG over, maintenance not
    expect(api.aircraft.get(1)!.hide_in_phoenix).toBe(true);
    await mxRelease(d(4.2)); // maintenance over too
    expect(api.aircraft.get(1)).toMatchObject({ hide_in_phoenix: false, internal_remarks: null });
  });

  it("maintenance then AOG: shown again only once BOTH are over", async () => {
    feed.flying.add(fleet[0]!.hex);
    await poll(T0);
    await mx({ landing_rate: -900 }, d(0.1)); // severe: hidden until d(3.1)
    feed.flying.delete(fleet[0]!.hex);
    await poll(d(3.2)); // not 3 days since last flight yet (last seen d0)… flight at d0.1 isn't ADS-B; still d(3.2)-d0 > 3 → AOG
    await mxRelease(d(3.3)); // maintenance over, AOG still on
    expect(api.aircraft.get(1)!.hide_in_phoenix).toBe(true);
    feed.flying.add(fleet[0]!.hex);
    await poll(d(3.5));
    expect(api.aircraft.get(1)).toMatchObject({ hide_in_phoenix: false, internal_remarks: null });
  });

  it("AOG ending while still in maintenance keeps the aircraft hidden", async () => {
    await poll(T0); await poll(d(3.01));
    await mx({}, d(3.1)); // hard landing → maintenance until 3.1 + 1 day
    feed.flying.add(fleet[0]!.hex);
    await poll(d(3.5));
    expect(api.aircraft.get(1)!.hide_in_phoenix).toBe(true);
  });

  it("maintenance ending while AOG keeps the aircraft hidden", async () => {
    await poll(T0); await poll(d(3.01));
    await mx({}, d(3.1));
    await releaseDue(api as unknown as VamsysPort, store, MX_CONFIG, {
      dryRun: false, now: d(5),
      heldElsewhere: async (id) => Boolean((await aogState(store)).aog[String(id)]),
    });
    expect(api.aircraft.get(1)!.hide_in_phoenix).toBe(true);
    expect(api.aircraft.get(1)!.internal_remarks).toContain("[AOG-AUTO]");
    expect(api.aircraft.get(1)!.internal_remarks).not.toContain("[MX-AUTO]");
  });
});
