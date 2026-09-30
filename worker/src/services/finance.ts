import type { Env } from "../env";
import {
  type CategoryRow,
  type DB,
  type DebtDirection,
  type Recurrence,
  type ReminderRow,
  type TransactionRow,
  type TxSource,
  type TxType,
  TX_SELECT,
  must,
} from "../lib/db";
import { monthBounds, parsePeriod, periodKey, safeTz } from "../lib/dates";
import type { UserRow } from "../lib/db";

export const FALLBACK_CATEGORY: Record<TxType, string> = {
  expense: "Lainnya",
  income: "Pemasukan Lain",
  transfer: "Transfer",
  debt: "Utang Piutang",
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface TelegramIdentity {
  telegramId: number;
  chatId: number;
  username?: string | null;
  firstName?: string | null;
}

/** Find or create the user behind an incoming Telegram message, keeping profile fields fresh. */
export async function upsertTelegramUser(db: DB, env: Env, who: TelegramIdentity): Promise<UserRow> {
  const existing = must(
    await db.from("users").select("*").eq("telegram_id", who.telegramId).maybeSingle(),
    "load user",
  ) as UserRow | null;
  const fresh = { telegram_chat_id: who.chatId, username: who.username ?? null, first_name: who.firstName ?? null };

  if (existing) {
    const changed =
      existing.telegram_chat_id !== fresh.telegram_chat_id ||
      existing.username !== fresh.username ||
      existing.first_name !== fresh.first_name;
    if (!changed) return existing;
    return must(await db.from("users").update(fresh).eq("id", existing.id).select("*").single(), "update user") as UserRow;
  }

  const { data, error } = await db
    .from("users")
    .insert({
      telegram_id: who.telegramId,
      ...fresh,
      timezone: safeTz(env.DEFAULT_TIMEZONE),
      currency: env.DEFAULT_CURRENCY || "IDR",
    })
    .select("*")
    .single();
  if (error) {
    // Concurrent first messages: another request inserted the row first.
    if (error.code === "23505") {
      return must(await db.from("users").select("*").eq("telegram_id", who.telegramId).single(), "reload user") as UserRow;
    }
    throw new Error(`create user: ${error.message}`);
  }
  return data as UserRow;
}
export async function getUser(db: DB, userId: number): Promise<UserRow | null> {
  return must(await db.from("users").select("*").eq("id", userId).maybeSingle(), "get user") as UserRow | null;
}

export async function updateUser(
  db: DB,
  userId: number,
  patch: Partial<Pick<UserRow, "monthly_budget" | "initial_balance" | "timezone" | "currency">>,
): Promise<UserRow> {
  return must(await db.from("users").update(patch).eq("id", userId).select("*").single(), "update user") as UserRow;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function listCategories(db: DB, userId: number): Promise<CategoryRow[]> {
  return must(
    await db
      .from("categories")
      .select("id,user_id,name,type,icon,color")
      .or(`user_id.is.null,user_id.eq.${userId}`)
      .order("type")
      .order("user_id", { nullsFirst: true })
      .order("id"),
    "list categories",
  ) as CategoryRow[];
}

function normalise(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Map a model-chosen category name to a real category, falling back to the type's default bucket. */
export function resolveCategory(categories: CategoryRow[], name: string | null | undefined, type: TxType): CategoryRow | null {
  const target = normalise(name ?? "");
  if (target) {
    const sameType = categories.filter((c) => c.type === type);
    const pool = sameType.length ? sameType : categories;
    const exact = pool.find((c) => normalise(c.name) === target) ?? categories.find((c) => normalise(c.name) === target);
    if (exact) return exact;
    const partial = pool.find((c) => normalise(c.name).includes(target) || target.includes(normalise(c.name)));
    if (partial) return partial;
  }
  return categories.find((c) => c.type === type && c.name === FALLBACK_CATEGORY[type]) ?? null;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface NewTransaction {
  type: TxType;
  amount: number;
  category_id: number | null;
  description: string;
  merchant?: string | null;
  payment_method?: string;
  debt_direction?: DebtDirection | null;
  counterparty?: string | null;
  transaction_date: string;
  source: TxSource;
  raw_input?: string | null;
  receipt_data?: unknown;
}

export async function insertTransactions(db: DB, userId: number, rows: NewTransaction[]): Promise<TransactionRow[]> {
  const payload = rows.map((r) => ({
    user_id: userId,
    type: r.type,
    amount: Math.round(r.amount * 100) / 100,
    category_id: r.category_id,
    description: (r.description || "").slice(0, 255),
    merchant: r.merchant ?? null,
    payment_method: r.payment_method || "Tunai",
    debt_direction: r.type === "debt" ? (r.debt_direction ?? "borrow") : null,
    counterparty: r.counterparty ?? null,
    transaction_date: r.transaction_date,
    source: r.source,
    raw_input: r.raw_input ?? null,
    receipt_data: r.receipt_data ?? null,
  }));
  return must(await db.from("transactions").insert(payload).select(TX_SELECT), "insert transactions") as TransactionRow[];
}

export async function deleteTransaction(db: DB, userId: number, id: number): Promise<boolean> {
  const data = must(
    await db.from("transactions").delete().eq("id", id).eq("user_id", userId).select("id"),
    "delete transaction",
  ) as { id: number }[];
  return data.length > 0;
}

export async function lastTransaction(db: DB, userId: number): Promise<TransactionRow | null> {
  return must(
    await db
      .from("transactions")
      .select(TX_SELECT)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "last transaction",
  ) as TransactionRow | null;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  period: string;
  currency: string;
  timezone: string;
  balance: number;
  monthly_income: number;
  monthly_expense: number;
  net_monthly: number;
  prev_month_income: number;
  prev_month_expense: number;
  total_debt: number;
  total_receivable: number;
  transaction_count: number;
  budget: { amount: number; spent: number; remaining: number; percent: number } | null;
  category_breakdown: {
    category_id: number | null;
    name: string;
    icon: string;
    color: string;
    total: number;
    count: number;
    percent: number;
  }[];
  daily: { date: string; income: number; expense: number }[];
}

export async function dashboardSummary(db: DB, user: UserRow, period?: string | null): Promise<DashboardSummary> {
  const { year, month } = parsePeriod(period, safeTz(user.timezone));
  const data = must(
    await db.rpc("dashboard_summary", { p_user_id: user.id, p_year: year, p_month: month }),
    "dashboard summary",
  );
  return data as DashboardSummary;
}

export async function getBalance(db: DB, userId: number): Promise<number> {
  return Number(must(await db.rpc("get_balance", { p_user_id: userId }), "balance") ?? 0);
}

/** Compact, anonymised month snapshot handed to the LLM for insights and Q&A. */
export async function monthSnapshot(db: DB, user: UserRow, period?: string | null) {
  const tz = safeTz(user.timezone);
  const summary = await dashboardSummary(db, user, period);
  const { year, month } = parsePeriod(period, tz);
  const [start, end] = monthBounds(year, month, tz);
  const txs = must(
    await db
      .from("transactions")
      .select("type,amount,description,merchant,payment_method,transaction_date,debt_direction,counterparty,category:categories(name)")
      .eq("user_id", user.id)
      .gte("transaction_date", start.toISOString())
      .lt("transaction_date", end.toISOString())
      .order("amount", { ascending: false })
      .limit(40),
    "snapshot transactions",
  ) as unknown as Array<Record<string, unknown> & { category: { name: string } | null }>;

  const activeDays = summary.daily.filter((d) => d.expense > 0).length;
  return {
    period: periodKey(year, month),
    currency: summary.currency,
    balance: summary.balance,
    income: summary.monthly_income,
    expense: summary.monthly_expense,
    net: summary.net_monthly,
    savings_rate_pct:
      summary.monthly_income > 0 ? Math.round((summary.net_monthly / summary.monthly_income) * 1000) / 10 : null,
    previous_month: { income: summary.prev_month_income, expense: summary.prev_month_expense },
    budget: summary.budget,
    outstanding_debt: summary.total_debt,
    receivables: summary.total_receivable,
    transaction_count: summary.transaction_count,
    days_with_spending: activeDays,
    expense_by_category: summary.category_breakdown.map((c) => ({ name: c.name, total: c.total, pct: c.percent, count: c.count })),
    largest_transactions: txs.map((t) => ({ ...t, category: t.category?.name ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export async function createReminder(
  db: DB,
  user: UserRow,
  r: { task: string; remind_at: string; recurrence: Recurrence; amount: number | null },
): Promise<ReminderRow> {
  return must(
    await db
      .from("reminders")
      .insert({
        user_id: user.id,
        task: r.task.slice(0, 255),
        amount: r.amount,
        remind_at: r.remind_at,
        anchor_at: r.remind_at,
        recurrence: r.recurrence,
      })
      .select("*")
      .single(),
    "create reminder",
  ) as ReminderRow;
}

export async function listReminders(db: DB, userId: number, statuses: string[] = ["pending", "sending"]): Promise<ReminderRow[]> {
  return must(
    await db.from("reminders").select("*").eq("user_id", userId).in("status", statuses).order("remind_at").limit(100),
    "list reminders",
  ) as ReminderRow[];
}

export async function cancelReminder(db: DB, userId: number, id: number): Promise<boolean> {
  const data = must(
    await db
      .from("reminders")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("user_id", userId)
      .in("status", ["pending", "failed"])
      .select("id"),
    "cancel reminder",
  ) as { id: number }[];
  return data.length > 0;
}
