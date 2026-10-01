/**
 * Who may use the bot.
 *
 * - Owners: IDs in the Cloudflare secret ALLOWED_TELEGRAM_IDS. Always allowed; can approve others.
 * - Everyone else: a row in public.allowed_users with status 'approved'.
 * - If ALLOWED_TELEGRAM_IDS is empty the bot is "open": anyone may use it and nobody can manage access.
 */
import { type Env, ownerTelegramIds } from "../env";
import { type DB, must } from "../lib/db";

export type Access = "owner" | "allowed" | "pending" | "blocked" | "unknown" | "open";
export type AllowedStatus = "pending" | "approved" | "blocked";

export interface AllowedUserRow {
  telegram_id: number;
  name: string | null;
  username: string | null;
  status: AllowedStatus;
  added_by: number | null;
  requested_at: string | null;
  decided_at: string | null;
  created_at: string;
}

export const canUse = (a: Access) => a === "owner" || a === "allowed" || a === "open";

// Short per-isolate cache so every message/API call doesn't hit the database. Changes made in this
// isolate clear it immediately; other isolates pick them up within CACHE_MS.
const CACHE_MS = 30_000;
const cache = new Map<number, { access: Access; until: number }>();

export function forgetAccess(telegramId?: number) {
  if (telegramId === undefined) cache.clear();
  else cache.delete(telegramId);
}

export async function accessFor(env: Env, db: DB, telegramId: number): Promise<Access> {
  const owners = ownerTelegramIds(env);
  if (owners.size === 0) return "open";
  if (owners.has(telegramId)) return "owner";

  const hit = cache.get(telegramId);
  if (hit && hit.until > Date.now()) return hit.access;

  const row = must(
    await db.from("allowed_users").select("status").eq("telegram_id", telegramId).maybeSingle(),
    "load access",
  ) as { status: AllowedStatus } | null;
  const access: Access = !row ? "unknown" : row.status === "approved" ? "allowed" : row.status;
  cache.set(telegramId, { access, until: Date.now() + CACHE_MS });
  return access;
}

/** Access for many Telegram IDs at once (used by the reminder cron). */
export async function accessForMany(env: Env, db: DB, telegramIds: number[]): Promise<Map<number, Access>> {
  const owners = ownerTelegramIds(env);
  const out = new Map<number, Access>();
  if (owners.size === 0) {
    for (const id of telegramIds) out.set(id, "open");
    return out;
  }
  const others = telegramIds.filter((id) => !owners.has(id));
  const rows = others.length
    ? (must(
        await db.from("allowed_users").select("telegram_id,status").in("telegram_id", others),
        "load access list",
      ) as { telegram_id: number; status: AllowedStatus }[])
    : [];
  const byId = new Map(rows.map((r) => [Number(r.telegram_id), r.status]));
  for (const id of telegramIds) {
    if (owners.has(id)) out.set(id, "owner");
    else {
      const s = byId.get(id);
      out.set(id, !s ? "unknown" : s === "approved" ? "allowed" : s);
    }
  }
  return out;
}

/** Record an access request from a stranger. Returns true only the first time (so owners are notified once). */
export async function requestAccess(
  db: DB,
  who: { telegramId: number; name: string | null; username: string | null },
): Promise<boolean> {
  const { data, error } = await db
    .from("allowed_users")
    .upsert(
      {
        telegram_id: who.telegramId,
        name: who.name,
        username: who.username,
        status: "pending",
        requested_at: new Date().toISOString(),
      },
      { onConflict: "telegram_id", ignoreDuplicates: true },
    )
    .select("telegram_id");
  if (error) throw new Error(`request access: ${error.message}`);
  forgetAccess(who.telegramId);
  return (data ?? []).length > 0;
}

export async function listAllowedUsers(db: DB): Promise<AllowedUserRow[]> {
  return must(
    await db.from("allowed_users").select("*").order("status").order("created_at", { ascending: false }),
    "list allowed users",
  ) as AllowedUserRow[];
}

export async function getAllowedUser(db: DB, telegramId: number): Promise<AllowedUserRow | null> {
  return must(
    await db.from("allowed_users").select("*").eq("telegram_id", telegramId).maybeSingle(),
    "get allowed user",
  ) as AllowedUserRow | null;
}

/** Approve (or add) someone. Returns the previous status, so callers know whether to notify them. */
export async function approveUser(
  db: DB,
  telegramId: number,
  byOwner: number,
  name?: string | null,
): Promise<AllowedStatus | null> {
  const before = await getAllowedUser(db, telegramId);
  must(
    await db.from("allowed_users").upsert(
      {
        telegram_id: telegramId,
        status: "approved",
        added_by: byOwner,
        decided_at: new Date().toISOString(),
        ...(name ? { name } : before ? {} : { name: null }),
      },
      { onConflict: "telegram_id" },
    ),
    "approve user",
  );
  forgetAccess(telegramId);
  return before?.status ?? null;
}

export async function blockUser(db: DB, telegramId: number, byOwner: number): Promise<void> {
  must(
    await db.from("allowed_users").upsert(
      { telegram_id: telegramId, status: "blocked", added_by: byOwner, decided_at: new Date().toISOString() },
      { onConflict: "telegram_id" },
    ),
    "block user",
  );
  forgetAccess(telegramId);
}

/** Remove someone from the list entirely. Their data stays; if they message again it counts as a new request. */
export async function removeAllowedUser(db: DB, telegramId: number): Promise<boolean> {
  const rows = must(
    await db.from("allowed_users").delete().eq("telegram_id", telegramId).select("telegram_id"),
    "remove allowed user",
  ) as { telegram_id: number }[];
  forgetAccess(telegramId);
  return rows.length > 0;
}

/** Text sent to the person once an owner approves them. */
export const APPROVED_MESSAGE =
  "✅ <b>Akses diizinkan!</b>\nKamu sekarang bisa memakai Catatku. Ketik /start untuk melihat contoh, atau langsung catat: <code>Beli kopi 20rb</code>";
