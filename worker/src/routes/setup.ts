/**
 * One-click setup page: https://<your-worker>/setup
 *
 * Replaces the command-line webhook script so the whole install can be done from a browser.
 * Protected by TELEGRAM_WEBHOOK_SECRET (typed into a form, never put in the URL).
 * It checks the configuration, tests the database, registers the Telegram webhook and the command menu.
 */
import { Hono } from "hono";
import type { AppContext, Env } from "../env";
import { allowedTelegramIds, publicUrl } from "../env";
import { sha256 } from "../lib/auth";
import { getDb } from "../lib/db";
import { escapeHtml, page } from "../lib/page";

export const setup = new Hono<AppContext>();

const COMMANDS = [
  { command: "saldo", description: "Saldo & status budget" },
  { command: "laporan", description: "Laporan bulan ini" },
  { command: "budget", description: "Atur budget bulanan, mis. /budget 3jt" },
  { command: "saldoawal", description: "Atur saldo awal" },
  { command: "pengingat", description: "Daftar pengingat aktif" },
  { command: "batal", description: "Batalkan pengingat, mis. /batal 12" },
  { command: "hapus", description: "Hapus transaksi, mis. /hapus 123" },
  { command: "undo", description: "Hapus transaksi terakhir" },
  { command: "dashboard", description: "Link masuk dashboard web" },
  { command: "help", description: "Bantuan & contoh" },
];

interface Check {
  ok: boolean;
  label: string;
  hint?: string;
}

async function telegram<T>(env: Env, method: string, payload: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  return json.result;
}

function renderChecks(checks: Check[]): string {
  return `<ul class="checks">${checks
    .map(
      (c) =>
        `<li><span class="${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✗"}</span><span>${escapeHtml(c.label)}${
          c.hint ? `<small>${escapeHtml(c.hint)}</small>` : ""
        }</span></li>`,
    )
    .join("")}</ul>`;
}

setup.get("/", (c) =>
  c.html(
    page(
      "Catatku setup",
      `<h1>🔧 Catatku setup</h1>
       <p>Paste your <b>TELEGRAM_WEBHOOK_SECRET</b> to check your settings and connect the bot to Telegram. You can run this as often as you like.</p>
       <form method="post" action="/setup">
         <input type="password" name="secret" id="secret" autocomplete="off" placeholder="TELEGRAM_WEBHOOK_SECRET" required>
         <button type="submit">Check &amp; connect</button>
       </form>`,
    ),
  ),
);

setup.post("/", async (c) => {
  const env = c.env;
  const form = await c.req.parseBody();
  const given = typeof form.secret === "string" ? form.secret.trim() : "";

  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return c.html(
      page("Catatku setup", `<h1>Almost there</h1><p>Add the secret <b>TELEGRAM_WEBHOOK_SECRET</b> in Cloudflare first, then reload this page.</p>`),
      400,
    );
  }
  // Compare hashes so the check takes the same time whatever was typed.
  if ((await sha256(given)) !== (await sha256(env.TELEGRAM_WEBHOOK_SECRET))) {
    return c.html(
      page("Catatku setup", `<h1>Wrong secret</h1><p>That doesn't match TELEGRAM_WEBHOOK_SECRET. Check for extra spaces and try again.</p><a class="btn" href="/setup">Try again</a>`),
      401,
    );
  }

  const checks: Check[] = [];
  const has = (name: keyof Env, hint: string) => {
    const ok = Boolean(env[name]);
    checks.push({ ok, label: String(name), hint: ok ? undefined : hint });
    return ok;
  };
  has("SUPABASE_URL", "Add it under Settings → Variables and Secrets.");
  has("SUPABASE_SECRET_KEY", "Add it under Settings → Variables and Secrets.");
  has("GEMINI_API_KEY", "Add it under Settings → Variables and Secrets.");
  has("SESSION_SECRET", "Add any long random text as this secret.");
  const tokenOk = has("TELEGRAM_BOT_TOKEN", "The token from @BotFather.");
  const allowed = allowedTelegramIds(env);
  checks.push({
    ok: allowed.size > 0,
    label: allowed.size ? `ALLOWED_TELEGRAM_IDS (${allowed.size} user${allowed.size > 1 ? "s" : ""})` : "ALLOWED_TELEGRAM_IDS",
    hint: allowed.size ? undefined : "Not set: anyone who finds your bot can use it. Add your Telegram ID.",
  });

  // Database: the SQL file must have been run in Supabase.
  if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) {
    try {
      const { count, error } = await getDb(env).from("categories").select("id", { count: "exact", head: true });
      if (error) throw new Error(error.message);
      checks.push({ ok: (count ?? 0) > 0, label: `Database connected (${count ?? 0} categories)`, hint: count ? undefined : "Run the SQL file in Supabase's SQL Editor." });
    } catch (err) {
      checks.push({ ok: false, label: "Database connection", hint: `${(err as Error).message}. Check SUPABASE_URL / SUPABASE_SECRET_KEY, and that you ran the SQL file.` });
    }
  }

  // Telegram: register the webhook for this Worker's URL and publish the command menu.
  let botName = "";
  if (tokenOk) {
    try {
      const me = await telegram<{ username: string }>(env, "getMe", {});
      botName = me.username;
      const base = publicUrl(env, c.req.url);
      await telegram(env, "setWebhook", {
        url: `${base}/telegram/webhook`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        max_connections: 40,
      });
      await telegram(env, "setMyCommands", { commands: COMMANDS });
      checks.push({ ok: true, label: `Telegram connected to @${botName}` });
    } catch (err) {
      checks.push({ ok: false, label: "Telegram connection", hint: `${(err as Error).message}. Check TELEGRAM_BOT_TOKEN.` });
    }
  }

  const allOk = checks.every((x) => x.ok);
  const next = botName
    ? `<a class="btn" href="https://t.me/${encodeURIComponent(botName)}" target="_blank" rel="noopener">Open @${escapeHtml(botName)} in Telegram</a>`
    : `<a class="btn" href="/setup">Run again</a>`;
  return c.html(
    page(
      "Catatku setup",
      `<h1>${allOk ? "✅ All set!" : "⚠️ Almost there"}</h1>
       <p>${allOk ? "Open your bot, tap <b>Start</b>, and send <b>Beli kopi 20rb</b>." : "Fix the red items in Cloudflare, then run this page again."}</p>
       ${renderChecks(checks)}
       ${next}`,
    ),
  );
});
