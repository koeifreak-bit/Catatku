import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { getTelegramBot } from "./channels/telegram";
import type { AppContext, Env } from "./env";
import { api } from "./routes/api";
import { auth } from "./routes/auth";
import { setup } from "./routes/setup";
import { dispatchDueReminders } from "./services/reminders";

const app = new Hono<AppContext>();

app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    telegram: Boolean(c.env.TELEGRAM_BOT_TOKEN),
    database: Boolean(c.env.SUPABASE_URL && c.env.SUPABASE_SECRET_KEY),
    ai: Boolean(c.env.GEMINI_API_KEY),
    model: c.env.GEMINI_MODEL,
  }),
);

/**
 * Telegram webhook. Acknowledge immediately and process in `waitUntil`, so slow AI calls
 * never make Telegram time out and redeliver the same update.
 */
app.post("/telegram/webhook", async (c) => {
  if (
    !c.env.TELEGRAM_BOT_TOKEN ||
    !c.env.TELEGRAM_WEBHOOK_SECRET ||
    c.req.header("X-Telegram-Bot-Api-Secret-Token") !== c.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return c.text("forbidden", 403);
  }
  const update = await c.req.json();
  // PUBLIC_URL is optional: default to this request's origin (e.g. https://catatku.<you>.workers.dev).
  const env: Env = c.env.PUBLIC_URL ? c.env : { ...c.env, PUBLIC_URL: new URL(c.req.url).origin };
  c.executionCtx.waitUntil(
    getTelegramBot(env)
      .then((bot) => bot.handleUpdate(update))
      .catch((err) => console.error("Telegram update failed", String(err))),
  );
  return c.text("ok");
});

app.route("/setup", setup);
app.route("/auth", auth);
app.route("/api", api);

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not_found" }, 404) : c.env.ASSETS.fetch(c.req.raw)));

app.onError((err, c) => {
  console.error("Unhandled error", { path: c.req.path, error: String(err) });
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      dispatchDueReminders(env)
        .then((r) => {
          if (r.sent || r.failed) console.log("Reminders dispatched", r);
        })
        .catch((err) => console.error("Reminder dispatch failed", String(err))),
    );
  },
} satisfies ExportedHandler<Env>;
