/**
 * Runs the real Supabase migration in PGlite (Postgres compiled to WebAssembly) and exercises
 * the SQL functions the Worker depends on: ledger maths, month boundaries in the user's timezone,
 * and reminder claiming / rescheduling.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATION: string = readFileSync(
  fileURLToPath(new URL("../../supabase/migrations/20260928000000_init.sql", import.meta.url).href),
  "utf8",
);

let db: PGlite;
let uid: number;
let food: number;

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]!;

async function tx(type: string, amount: number, date: string, dir: string | null = null, cat: number | null = null) {
  await db.query(
    `insert into transactions (user_id, type, amount, transaction_date, debt_direction, category_id) values ($1,$2,$3,$4,$5,$6)`,
    [uid, type, amount, date, dir, cat],
  );
}

async function reminder(at: string, recurrence = "none"): Promise<number> {
  const row = await one<{ id: number }>(
    `insert into reminders (user_id, task, remind_at, anchor_at, recurrence) values ($1,'Bayar listrik',$2,$2,$3) returning id`,
    [uid, at, recurrence],
  );
  return row.id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;`); // Supabase roles
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // must be safe to run twice

  uid = (await one<{ id: number }>(
    `insert into users (telegram_id, telegram_chat_id, timezone, monthly_budget, initial_balance)
     values (111, 111, 'Asia/Jakarta', 3000000, 1000000) returning id`,
  )).id;
  food = (await one<{ id: number }>(`select id from categories where name = 'Makanan & Minuman'`)).id;

  await tx("expense", 50000, "2026-09-10T05:00:00Z", null, food);
  await tx("income", 10000000, "2026-09-01T02:00:00Z");
  await tx("debt", 100000, "2026-09-05T02:00:00Z", "borrow");
  await tx("debt", 40000, "2026-09-06T02:00:00Z", "repay");
  await tx("debt", 20000, "2026-09-07T02:00:00Z", "lend");
  await tx("transfer", 30000, "2026-09-08T02:00:00Z");
  await tx("expense", 25000, "2026-09-30T16:30:00Z", null, food); // 30 Sep 23:30 WIB
  await tx("expense", 15000, "2026-09-30T17:30:00Z"); //               1 Oct 00:30 WIB
  await tx("expense", 99000, "2026-08-15T05:00:00Z"); //               previous month
}, 30_000);

describe("schema", () => {
  it("seeds 20 built-in categories exactly once", async () => {
    expect((await one<{ n: number }>(`select count(*)::int n from categories where user_id is null`)).n).toBe(20);
  });

  it("rejects a debt without a direction", async () => {
    await expect(tx("debt", 1000, "2026-09-09T00:00:00Z", null)).rejects.toThrow();
  });

  it("rejects duplicate custom categories for the same user", async () => {
    await db.query(`insert into categories (user_id, name, type) values ($1, 'Kopi', 'expense')`, [uid]);
    await expect(db.query(`insert into categories (user_id, name, type) values ($1, 'Kopi', 'expense')`, [uid])).rejects.toThrow();
  });
});

describe("ledger", () => {
  it("computes the balance from the ledger", async () => {
    const { b } = await one<{ b: string }>(`select get_balance($1) b`, [uid]);
    expect(Number(b)).toBe(1_000_000 + 10_000_000 - 189_000 + 100_000 - 40_000 - 20_000);
  });

  it("summarises a month in the user's timezone", async () => {
    const { s } = await one<{ s: any }>(`select dashboard_summary($1, 2026, 9) s`, [uid]);
    expect(Number(s.monthly_expense)).toBe(75_000); // includes 23:30 WIB on the 30th, excludes 00:30 on the 1st
    expect(Number(s.monthly_income)).toBe(10_000_000);
    expect(Number(s.prev_month_expense)).toBe(99_000);
    expect(Number(s.total_debt)).toBe(60_000);
    expect(Number(s.total_receivable)).toBe(20_000);
    expect(Number(s.budget.percent)).toBe(2.5);
    expect(s.daily).toHaveLength(30);
    expect(s.daily[29]).toMatchObject({ date: "2026-09-30" });
    expect(Number(s.daily[29].expense)).toBe(25_000);
    expect(s.category_breakdown).toHaveLength(1);
  });

  it("puts the 00:30 WIB expense in October, uncategorised", async () => {
    const { s } = await one<{ s: any }>(`select dashboard_summary($1, 2026, 10) s`, [uid]);
    expect(Number(s.monthly_expense)).toBe(15_000);
    expect(s.category_breakdown[0].name).toBe("Tanpa Kategori");
  });
});

describe("reminders", () => {
  it("claims due reminders once and schedules recurring ones from their anchor", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const oneOff = await reminder(past);
    const monthly = await reminder("2026-01-31T02:00:00Z", "monthly"); // 31 Jan 09:00 WIB
    const future = await reminder(new Date(Date.now() + 3_600_000).toISOString());

    const claimed = (await db.query<{ id: number; status: string; attempts: number }>(`select * from claim_due_reminders(20)`)).rows;
    expect(claimed.map((r) => r.id).sort()).toEqual([oneOff, monthly].sort());
    expect(claimed.every((r) => r.status === "sending" && r.attempts === 1)).toBe(true);
    expect(claimed.some((r) => r.id === future)).toBe(false);
    expect((await db.query(`select * from claim_due_reminders(20)`)).rows).toHaveLength(0);

    await db.query(`select finish_reminder($1, true)`, [oneOff]);
    expect((await one<{ status: string }>(`select status from reminders where id=$1`, [oneOff])).status).toBe("sent");

    await db.query(`select finish_reminder($1, true)`, [monthly]);
    const next = await one<{ status: string; remind_at: string; local: string }>(
      `select status, remind_at, to_char(remind_at at time zone 'Asia/Jakarta', 'DD HH24:MI') local from reminders where id=$1`,
      [monthly],
    );
    expect(next.status).toBe("pending");
    expect(new Date(next.remind_at).getTime()).toBeGreaterThan(Date.now());
    expect(next.local.endsWith("09:00")).toBe(true);
  });

  it("retries failures, then gives up on permanent ones", async () => {
    const id = await reminder(new Date(Date.now() - 60_000).toISOString());
    await db.query(`select * from claim_due_reminders(20)`);
    await db.query(`select finish_reminder($1, false, 'boom')`, [id]);
    const retry = await one<{ status: string; remind_at: string }>(`select status, remind_at from reminders where id=$1`, [id]);
    expect(retry.status).toBe("pending");
    expect(new Date(retry.remind_at).getTime()).toBeGreaterThan(Date.now());

    await db.query(`select finish_reminder($1, false, 'blocked', true)`, [id]);
    expect((await one<{ status: string }>(`select status from reminders where id=$1`, [id])).status).toBe("failed");
  });

  it("reclaims reminders stuck in 'sending' after a crashed run", async () => {
    const id = await reminder(new Date(Date.now() - 60_000).toISOString());
    await db.query(`update reminders set status='sending', claimed_at=now() - interval '10 minutes' where id=$1`, [id]);
    const claimed = (await db.query<{ id: number }>(`select * from claim_due_reminders(20)`)).rows;
    expect(claimed.some((r) => r.id === id)).toBe(true);
  });
});
