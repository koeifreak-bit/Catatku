import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config";
import { processPirep, runCycle, type Store } from "../src/process";
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
const td = (distFt: number | null, lda = 9000, runway = "RW25R"): Touchdown =>
  ({ index: 0, rate: -150, runway, lda, distance_from_start_ft: distFt, time: null });

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
    api.touchdowns.set(2, [td(3300)]); // 1006 m
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(r).toMatchObject({ rejected: true, score: { points: -200 } });
    expect(api.calls).toEqual(["bonus:2", "comment:2", "reject:2"]);
  });

  it("does not reject a long-but-inside-TDZ landing", async () => {
    api.pireps = [pirep(3)];
    api.touchdowns.set(3, [td(2500)]); // 762 m → −100
    const r = await processPirep(api, store, api.pireps[0]!, cfg, live);
    expect(r).toMatchObject({ rejected: false, score: { points: -100 } });
    expect(api.calls).not.toContain("reject:3");
  });

  it("uses the last touchdown with data (bounces)", async () => {
    api.pireps = [pirep(4)];
    api.touchdowns.set(4, [td(800), td(1700), td(null)]);
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
});
