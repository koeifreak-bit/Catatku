import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";

export type TxType = "expense" | "income" | "transfer" | "debt";
export type DebtDirection = "borrow" | "repay" | "lend" | "collect";
export type Recurrence = "none" | "daily" | "weekly" | "monthly";
export type TxSource = "telegram_text" | "telegram_voice" | "telegram_receipt" | "dashboard";

export interface UserRow {
  id: number;
  telegram_id: number;
  telegram_chat_id: number;
  username: string | null;
  first_name: string | null;
  currency: string;
  timezone: string;
  monthly_budget: number;
  initial_balance: number;
  created_at: string;
}

export interface CategoryRow {
  id: number;
  user_id: number | null;
  name: string;
  type: TxType;
  icon: string;
  color: string;
}

export interface TransactionRow {
  id: number;
  user_id: number;
  type: TxType;
  amount: number;
  category_id: number | null;
  description: string;
  merchant: string | null;
  payment_method: string;
  debt_direction: DebtDirection | null;
  counterparty: string | null;
  transaction_date: string;
  source: TxSource;
  raw_input: string | null;
  receipt_data: unknown;
  created_at: string;
  category?: Pick<CategoryRow, "id" | "name" | "icon" | "color" | "type"> | null;
}

export interface ReminderRow {
  id: number;
  user_id: number;
  task: string;
  amount: number | null;
  remind_at: string;
  anchor_at: string;
  occurrence: number;
  recurrence: Recurrence;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number;
  last_sent_at: string | null;
  last_error: string | null;
  created_at: string;
}

export type DB = SupabaseClient;

// One client per isolate; supabase-js is stateless over fetch when session persistence is off.
let cached: { url: string; client: DB } | null = null;

export function getDb(env: Env): DB {
  if (cached && cached.url === env.SUPABASE_URL) return cached.client;
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  cached = { url: env.SUPABASE_URL, client };
  return client;
}

/** Throw on a Supabase error so callers can use plain async/await. */
export function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export const TX_SELECT = "*, category:categories(id,name,icon,color,type)";
