import { Api, GrammyError, InlineKeyboard } from "grammy";
import { reminderNotification } from "../core/format";
import { type Env, ownerTelegramIds } from "../env";
import { type ReminderRow, type UserRow, getDb, must } from "../lib/db";
import { safeTz } from "../lib/dates";
import { type Access, accessForMany, canUse } from "./access";

/**
 * Called by the per-minute Cron Trigger. Claims due reminders atomically in Postgres
 * (FOR UPDATE SKIP LOCKED), pushes them to Telegram, then records the outcome —
 * which also schedules the next occurrence for recurring reminders.
 *
 * At most 20 per run: each costs 2 subrequests and the free Workers plan allows 50 per
 * invocation. Any extra are picked up on the next minute.
 */
export async function dispatchDueReminders(env: Env): Promise<{ sent: number; failed: number }> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.SUPABASE_URL) return { sent: 0, failed: 0 };
  const db = getDb(env);
  const api = new Api(env.TELEGRAM_BOT_TOKEN);

  const due = must(await db.rpc("claim_due_reminders", { p_limit: 20 }), "claim reminders") as ReminderRow[];
  if (!due.length) return { sent: 0, failed: 0 };

  const userIds = [...new Set(due.map((r) => r.user_id))];
  const users = must(
    await db.from("users").select("id,telegram_id,telegram_chat_id,timezone,currency").in("id", userIds),
    "load reminder users",
  ) as Pick<UserRow, "id" | "telegram_id" | "telegram_chat_id" | "timezone" | "currency">[];
  const byId = new Map(users.map((u) => [u.id, u]));
  // People removed or blocked by an owner stop getting reminders too. If the lookup itself fails
  // (e.g. the people-list SQL hasn't been run yet), owners still get theirs and nobody's are lost.
  let access: Map<number, Access>;
  try {
    access = await accessForMany(env, db, users.map((u) => Number(u.telegram_id)));
  } catch (err) {
    console.error("Access lookup failed; only owners get reminders this run", String(err));
    const owners = ownerTelegramIds(env);
    access = new Map(users.map((u) => [Number(u.telegram_id), owners.size === 0 || owners.has(Number(u.telegram_id)) ? "owner" : "unknown"]));
  }

  let sent = 0;
  let failed = 0;
  await Promise.all(
    due.map(async (r) => {
      const u = byId.get(r.user_id);
      const keyboard = new InlineKeyboard().text("✅ Sudah", `done:${r.id}`).text("⏰ Tunda 1 jam", `snooze:${r.id}`);
      try {
        if (!u) throw new Error("Reminder owner not found");
        if (!canUse(access.get(Number(u.telegram_id)) ?? "unknown")) {
          // Paused, not destroyed: put it back and look again in an hour. If an owner lets this person
          // back in, their reminders (including recurring ones) carry on.
          await db
            .from("reminders")
            .update({ status: "pending", claimed_at: null, attempts: 0, remind_at: new Date(Date.now() + 3_600_000).toISOString() })
            .eq("id", r.id);
          return;
        }
        await api.sendMessage(u.telegram_chat_id, reminderNotification(r, safeTz(u.timezone), u.currency), {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
        await db.rpc("finish_reminder", { p_id: r.id, p_success: true });
        sent++;
      } catch (err) {
        failed++;
        // 403 = user blocked the bot, 400 = chat not found: retrying will never help.
        const permanent = !u || (err instanceof GrammyError && (err.error_code === 403 || err.error_code === 400));
        console.error("Reminder delivery failed", { id: r.id, error: String(err), permanent });
        await db.rpc("finish_reminder", {
          p_id: r.id,
          p_success: false,
          p_error: String(err).slice(0, 500),
          p_permanent: permanent,
        });
      }
    }),
  );
  return { sent, failed };
}
