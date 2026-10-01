import { beforeEach, describe, expect, it } from "vitest";
import { type Env, ownerTelegramIds } from "../src/env";
import type { DB } from "../src/lib/db";
import { accessFor, accessForMany, canUse, forgetAccess } from "../src/services/access";

/** Minimal stand-in for the Supabase query builder used by services/access.ts. */
function fakeDb(rows: Record<number, string>): DB & { calls: number } {
  const state = { calls: 0 };
  const builder = (filter: { id?: number; ids?: number[] } = {}) => ({
    select: () => builder(filter),
    eq: (_col: string, id: number) => builder({ ...filter, id }),
    in: (_col: string, ids: number[]) => {
      state.calls++;
      const data = ids.filter((i) => rows[i]).map((i) => ({ telegram_id: i, status: rows[i] }));
      return Promise.resolve({ data, error: null });
    },
    maybeSingle: () => {
      state.calls++;
      const s = filter.id !== undefined ? rows[filter.id] : undefined;
      return Promise.resolve({ data: s ? { status: s } : null, error: null });
    },
  });
  const db = { from: () => builder() } as unknown as DB & { calls: number };
  Object.defineProperty(db, "calls", { get: () => state.calls });
  return db;
}

const env = (ids: string) => ({ ALLOWED_TELEGRAM_IDS: ids }) as unknown as Env;

beforeEach(() => forgetAccess());

describe("owners", () => {
  it("parses ALLOWED_TELEGRAM_IDS leniently and ignores junk", () => {
    expect([...ownerTelegramIds(env(" 111, 222 ;333\n abc, -5, 1.5 "))]).toEqual([111, 222, 333]);
    expect(ownerTelegramIds(env("")).size).toBe(0);
  });
});

describe("accessFor", () => {
  const db = fakeDb({ 500: "approved", 600: "pending", 700: "blocked" });

  it("treats owners and approved people as allowed", async () => {
    expect(await accessFor(env("111"), db, 111)).toBe("owner");
    expect(await accessFor(env("111"), db, 500)).toBe("allowed");
    expect(canUse("owner") && canUse("allowed")).toBe(true);
  });

  it("keeps pending, blocked and unknown people out", async () => {
    for (const [id, expected] of [[600, "pending"], [700, "blocked"], [999, "unknown"]] as const) {
      const a = await accessFor(env("111"), db, id);
      expect(a).toBe(expected);
      expect(canUse(a)).toBe(false);
    }
  });

  it("is open to everyone when no owner is configured", async () => {
    expect(await accessFor(env(""), db, 999)).toBe("open");
    expect(canUse("open")).toBe(true);
  });

  it("caches lookups until forgotten", async () => {
    const counting = fakeDb({ 500: "approved" });
    await accessFor(env("111"), counting, 500);
    await accessFor(env("111"), counting, 500);
    expect(counting.calls).toBe(1);
    forgetAccess(500);
    await accessFor(env("111"), counting, 500);
    expect(counting.calls).toBe(2);
  });
});

describe("accessForMany", () => {
  it("resolves a batch with one query", async () => {
    const db = fakeDb({ 500: "approved", 700: "blocked" });
    const m = await accessForMany(env("111"), db, [111, 500, 700, 999]);
    expect(Object.fromEntries(m)).toEqual({ 111: "owner", 500: "allowed", 700: "blocked", 999: "unknown" });
    expect(db.calls).toBe(1);
  });
});
