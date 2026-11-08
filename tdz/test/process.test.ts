import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config";
import { MAX_ATTEMPTS, processPirep, runCycle, type Store } from "../src/process";
import type { PirepDetail, PirepSummary, PointEntry, Touchdown, VamsysPort } from "../src/vamsys";

class MemStore implements Store {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
}

class FakeApi implements VamsysPort {
  pireps: PirepSummary[] = [];
  touchdowns = new Map<number, Touchdown[]>();
  bonus = new Map<number, PointEntry[]>();
  calls: string[] = [];

  async listPireps(size: number, cursor?: string) {
    const sorted = [...this.pireps].sort((a, b) => b.id - a.id);
    const start = cursor ? Number(cursor) : 0;
    const data = sorted.slice(start, start + size);
    return { data, nextCursor: start + size < sorted.length ? String(start + size) : null };
  }
  async getPirep(id: number): Promise<PirepDetail> {
    const p = this.pireps.find((x) => x.id === id)!;
    return { ...p, pirep_data: { bonus_scores: this.bonus.get(id) ?? [] } };
  }
  async getTouchdowns(id: number) { return this.touchdowns.get(id) ?? []; }
  async putBonusPoints(id: number, e: PointEntry[]) { this.calls.push(`bonus:${id}`); this.bonus.set(id, e); return e.reduce((s, x) => s + x.points, 0); }
  async addComment(id: number) { this.calls.push(`comment:${id}`); }
  async reject(id: number) { this.calls.push(`reject:${id}`); const p = this.pireps.find((x) => x.id === id)!; p.status = "rejected"; }
}

const pirep = (id: number, status = "accepted"): PirepSummary => ({ id, status, type: "scheduled", callsign: `IJV${id}`, bonus_sum: 0 });
/** `runwayFt` = full runway; vAMSYS reports `lda` as the remainder after touchdown. */
const td = (distFt: number | null, runwayFt = 9000, runway = "RW25R"): Touchdown =>
  ({ index: 0, rate: -150, runway, lda: distFt == null ? null : runwayFt - distFt, distance_from_start_ft: distFt, time: null });

let api: FakeApi;
let store: MemStore;
const live = { dryRun: false };

beforeEach(() => { api = new FakeApi(); store = new MemStore(); });

describe("processPirep", () => {
  it("adds a TDZ bonus and keeps existing bonus entries (event, rank...)", async () => {
    api.pireps = [pirep(1)];
    api.touchdowns.set(1, [td(1150)]); // 350 m → aiming point +100
    api.bonus.set(1, [{ name: "Event: Bali Fly-in", points: 200, type: "event", id: 7 }]);

    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);

    expect(r.outcome).toBe("scored");
    expect(api.bonus.get(1)).toEqual([
      { name: "Event: Bali Fly-in", points: 200, type: "event", id: 7 },
      { name: "TDZ: Aiming point landing (351 m, RW25R)", points: 100 },
    ]);
    expect(api.calls).toEqual(["bonus:1", "comment:1"]);
  });

  it("is idempotent: a second run does nothing", async () => {
    api.pireps = [pirep(1)];
    api.touchdowns.set(1, [td(1150)]);
    await processPirep(api, store, api.pireps[0]!, cfg, live);
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(r).toMatchObject({ outcome: "skipped", reason: "already processed" });
    expect(api.calls).toHaveLength(2);
  });

  it("replaces (not stacks) its own entry when forced to re-score", async () => {
    api.pireps = [pirep(1)];
    api.touchdowns.set(1, [td(1150)]);
    await processPirep(api, store, api.pireps[0]!, cfg, live);
    await processPirep(api, store, api.pireps[0]!, cfg, { ...live, force: true });
    expect(api.bonus.get(1)!.filter((e) => e.name.startsWith("TDZ:"))).toHaveLength(1);
  });

  it("applies −200 and rejects beyond the TDZ end", async () => {
    api.pireps = [pirep(2)];
    api.touchdowns.set(2, [td(3300)]); // 1006 m, past the 922.5 m end
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(r).toMatchObject({ rejected: true, score: { points: -200 } });
    expect(api.calls).toEqual(["bonus:2", "comment:2", "reject:2"]);
  });

  it("does not reject a long-but-inside-TDZ landing", async () => {
    api.pireps = [pirep(3)];
    api.touchdowns.set(3, [td(3000)]); // 914 m → 0, still inside the last marking
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(r).toMatchObject({ rejected: false, score: { points: 0 } });
    expect(api.calls).not.toContain("reject:3");
  });

  it("uses the last touchdown with data (bounces)", async () => {
    api.pireps = [pirep(4)];
    api.touchdowns.set(4, [td(800), td(1700), td(null)]); // 518 m
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(Math.round(r.score!.distM)).toBe(518);
  });

  it("skips PIREPs without touchdown data, and rejected ones, without writing", async () => {
    api.pireps = [pirep(5), pirep(6, "rejected")];
    api.touchdowns.set(5, [td(null)]);
    expect(await processPirep(api, store, api.pireps[0]!, cfg, live)).toMatchObject({ outcome: "skipped", reason: "no touchdown data" });
    expect(await processPirep(api, store, api.pireps[1]!, cfg, live)).toMatchObject({ outcome: "skipped", reason: "status rejected" });
    expect(api.calls).toEqual([]);
  });

  it("dry run computes everything but writes nothing to vAMSYS", async () => {
    api.pireps = [pirep(7)];
    api.touchdowns.set(7, [td(3300)]);
    const r = await processPirep(api, store, api.pireps[0]!, cfg, { dryRun: true });
    expect(r).toMatchObject({ outcome: "scored", rejected: true, dryRun: true });
    expect(api.calls).toEqual([]);
    expect(store.m.has("result:7")).toBe(true);
  });

  it("reports API errors without marking the PIREP done", async () => {
    api.pireps = [pirep(8)];
    api.getTouchdowns = async () => { throw new Error("boom"); };
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(r).toMatchObject({ outcome: "error", reason: "boom" });
    expect(store.m.has("done:live:8")).toBe(false);
  });
});

describe("runCycle", () => {
  it("first run only records the newest id (no backfill)", async () => {
    api.pireps = [pirep(10), pirep(11)];
    api.touchdowns.set(11, [td(1150)]);
    expect(await runCycle(api, store, cfg, live)).toEqual([]);
    expect(store.m.get("lastSeenId")).toBe("11");
    expect(api.calls).toEqual([]);
  });

  it("processes only newer PIREPs, oldest first, across pages", async () => {
    store.m.set("lastSeenId", "100");
    api.pireps = Array.from({ length: 80 }, (_, i) => pirep(61 + i)); // ids 61..140
    for (const p of api.pireps) api.touchdowns.set(p.id, [td(1150)]);
    const results = await runCycle(api, store, cfg, live);
    expect(results.map((r) => r.pirepId)).toEqual(Array.from({ length: 40 }, (_, i) => 101 + i));
    expect(store.m.get("lastSeenId")).toBe("140");
    expect(await runCycle(api, store, cfg, live)).toEqual([]);
  });

  it("never skips older PIREPs when more than maxPerRun are waiting", async () => {
    store.m.set("lastSeenId", "100");
    api.pireps = Array.from({ length: 10 }, (_, i) => pirep(101 + i));
    for (const p of api.pireps) api.touchdowns.set(p.id, [td(1150)]);
    const first = await runCycle(api, store, cfg, live, 4);
    expect(first.map((r) => r.pirepId)).toEqual([101, 102, 103, 104]);
    const second = await runCycle(api, store, cfg, live, 4);
    expect(second.map((r) => r.pirepId)).toEqual([105, 106, 107, 108]);
  });

  it("retries a PIREP after an API error, then gives up after MAX_ATTEMPTS", async () => {
    store.m.set("lastSeenId", "100");
    api.pireps = [pirep(101), pirep(102)];
    api.touchdowns.set(102, [td(1150)]);
    const real = api.getTouchdowns.bind(api);
    api.getTouchdowns = async (id) => { if (id === 101) throw new Error("503"); return real(id); };

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = await runCycle(api, store, cfg, live);
      expect(r.map((x) => x.outcome)).toEqual(["error"]); // stops, 102 waits
      expect(store.m.get("lastSeenId")).toBe("100");
    }
    const last = await runCycle(api, store, cfg, live);
    expect(last.map((x) => [x.pirepId, x.outcome])).toEqual([[101, "error"], [102, "scored"]]);
    expect(store.m.get("lastSeenId")).toBe("102");
  });

  it("a PIREP that recovers on retry is scored", async () => {
    store.m.set("lastSeenId", "100");
    api.pireps = [pirep(101)];
    api.touchdowns.set(101, [td(1150)]);
    const real = api.getTouchdowns.bind(api);
    let fail = true;
    api.getTouchdowns = async (id) => { if (fail) { fail = false; throw new Error("timeout"); } return real(id); };
    await runCycle(api, store, cfg, live);
    const r = await runCycle(api, store, cfg, live);
    expect(r.map((x) => x.outcome)).toEqual(["scored"]);
  });

  it("replaces its old TDZ entry with a 0-point one when a re-score earns 0, keeping others", async () => {
    api.pireps = [pirep(9)];
    api.touchdowns.set(9, [td(968)]); // 295 m → 0 under the current rule
    api.bonus.set(9, [{ name: "TDZ: TDZ landing (295 m, RW25R)", points: 50 }, { name: "Rank bonus", points: 10 }]);
    await processPirep(api, store, api.pireps[0]!, cfg, { ...live, force: true });
    expect(api.bonus.get(9)).toEqual([{ name: "Rank bonus", points: 10 }, { name: "TDZ: Early touchdown (295 m, RW25R)", points: 0 }]);
  });

  it("never sends an empty bonus list (vAMSYS answers 422)", async () => {
    api.pireps = [pirep(13)];
    api.touchdowns.set(13, [td(968)]);
    api.bonus.set(13, [{ name: "TDZ: TDZ landing (295 m, RW25R)", points: 50 }]);
    const put = api.putBonusPoints.bind(api);
    api.putBonusPoints = async (id, e) => { if (!e.length) throw new Error("422 points required"); return put(id, e); };
    const r = await processPirep(api, store, api.pireps[0]!, cfg, { ...live, force: true });
    expect(r.outcome).toBe("scored");
    expect(api.bonus.get(13)).toEqual([{ name: "TDZ: Early touchdown (295 m, RW25R)", points: 0 }]);
  });

  it("does not write bonus points for a 0-point result on a fresh PIREP", async () => {
    api.pireps = [pirep(14)];
    api.touchdowns.set(14, [td(2000)]); // 610 m → 0
    await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(api.calls).toEqual(["comment:14"]);
  });

  it("treats vAMSYS lda as runway remaining (real WIII case: 636 m on 3000 m is not rejected)", async () => {
    api.pireps = [pirep(12)];
    api.touchdowns.set(12, [{ index: 0, rate: -195, runway: "RW06", lda: 7754.4, distance_from_start_ft: 2087, time: null }]);
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(r).toMatchObject({ rejected: false, score: { pairs: 6, tdzEndM: 922.5, points: 0 } });
  });

  it("short runway (< 2500 m): −200 written, comment explains, no reject", async () => {
    api.pireps = [pirep(15)];
    api.touchdowns.set(15, [td(2100, 6500)]); // 640 m on a 1981 m runway (4 pairs → 622.5 m)
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(r).toMatchObject({ rejected: false, score: { points: -200 } });
    expect(r.comment).toContain("not rejected");
    expect(api.calls).toEqual(["bonus:15", "comment:15"]);
  });
});
