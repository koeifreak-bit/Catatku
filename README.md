# Catatku — AI finance tracker on Telegram (Cloudflare + Supabase)

An open-source personal-finance assistant in the spirit of Nyatat: log money by chatting with a Telegram bot in Indonesian
or English, snap receipts for automatic OCR, set bill reminders in plain language, and watch everything on a web dashboard.

**Runs entirely on free tiers and entirely in the cloud:** Cloudflare Workers (bot + API + dashboard + reminders), Supabase
Postgres (database), and Google Gemini (AI). Your computer doesn't need to stay on, and **you don't need to install anything**:
the code goes on GitHub and Cloudflare builds and deploys it for you.

```
 Telegram ──webhook──►  Cloudflare Worker  (one deploy, one URL: https://catatku.<you>.workers.dev)
                        ├─ /telegram/webhook   grammY bot: text, receipts, reminders, commands
                        ├─ /setup              one-click setup & health check page
                        ├─ /api/*              Hono REST API for the dashboard (session cookie)
                        ├─ /auth/*             one-time login links issued by the bot
                        ├─ static assets       Next.js 14 dashboard (static export)
                        └─ Cron  * * * * *     reminder dispatcher
                                │
                     ┌──────────┴──────────┐
               Supabase Postgres      Gemini API (structured JSON output,
               (tables + SQL funcs)   text parsing + receipt vision OCR)

 GitHub repo ──push──► Cloudflare Workers Builds ──► builds the dashboard + deploys the Worker
```

## Features

- **Natural-language logging:** `Beli makan siang 50rb`, `Gaji masuk 10jt`, `Beli bensin 35k kemarin pakai GoPay`,
  `Kopi 20rb dan roti 15rb` (two transactions), `Utang ke Budi 100rb`. The bot understands `k / rb / ribu / jt / juta / M`,
  Indonesian thousand separators (`Rp 1.250.000`), and relative dates (`kemarin`, `tadi pagi`, `tgl 3`).
  It replies with a confirmation, your balance, and budget progress, plus a 🗑 undo button.
- **Voice notes:** hold the mic button and say eli bensin tiga puluh lima ribu. Gemini transcribes and logs it; the bot shows what it heard.
- **Receipt OCR:** send a photo of a receipt, e-commerce screenshot, or QRIS/transfer proof. It extracts the merchant, line items,
  tax, service, discount, total, date, category, and payment method, then saves it with the itemised detail.
- **Reminders:** `Ingatkan bayar listrik tanggal 25 jam 9 pagi`, `Ingatkan bayar kos tiap tanggal 1`. They're stored in Postgres and
  dispatched every minute by a Cron Trigger, with ✅ Done / ⏰ Snooze 1 hour buttons. Daily, weekly, and monthly recurrence are supported.
- **Questions:** `Berapa pengeluaran makan bulan ini?` is answered from your own data.
- **Dashboard:** balance, monthly income and expense (vs last month), total debt and receivables, a budget progress bar,
  spending by category, a daily or cumulative spending trend vs budget pace, and an AI financial-health summary. It also has a
  transactions table with search, filters, sort, pagination, add/edit/delete, receipt detail, and **CSV / Excel export**,
  plus a reminders manager.
- **Private by default:** an allow-list of Telegram IDs, a dashboard login that only works through a one-time link from the bot,
  and database functions locked down to the Worker's secret key.

## Project structure

```
catatku/
├── README.md
├── supabase/
│   └── migrations/20260928000000_init.sql   # tables, RLS, seed categories, SQL functions
├── worker/                                  # Cloudflare Worker (TypeScript)
│   ├── wrangler.jsonc                       # assets, cron, non-secret settings
│   ├── .dev.vars.example                    # secrets template (local development only)
│   ├── package.json / tsconfig.json
│   ├── scripts/login-link.mjs               # mint a dashboard login link manually (local dev)
│   ├── src/
│   │   ├── index.ts                         # Hono app, webhook route, scheduled() handler
│   │   ├── env.ts                           # settings and secrets
│   │   ├── core/assistant.ts                # bot logic: commands, AI parsing, receipts, buttons
│   │   ├── core/format.ts                   # Telegram message templates
│   │   ├── channels/telegram.ts             # grammY adapter
│   │   ├── routes/setup.ts                  # /setup page: checks settings, connects the webhook
│   │   ├── routes/api.ts                    # dashboard REST API
│   │   ├── routes/auth.ts                   # one-time-link login → session cookie
│   │   ├── services/ai.ts                   # Gemini prompts + zod structured-output schemas
│   │   ├── services/finance.ts              # users, categories, ledger, summaries, reminders
│   │   ├── services/reminders.ts            # cron dispatcher
│   │   └── lib/                             # db client, auth, money parsing, timezone utils
│   └── test/                                # vitest: amounts, timezones, Gemini schemas, and the SQL
│                                            # migration run against real Postgres (PGlite)
└── web/                                     # Next.js 14 dashboard (App Router, Tailwind, Recharts)
    ├── app/page.tsx                         # overview
    ├── app/transactions/page.tsx            # data table
    ├── app/reminders/page.tsx
    ├── components/                          # shadcn-style UI, charts, forms
    └── lib/api.ts, lib/export.ts, …         # API client, CSV/XLSX export
```

## Setup (about 45 minutes, all in the browser)

There's also a click-through flowchart version of these steps: the **Catatku Setup Map** artifact.

**You need:** a free [GitHub](https://github.com/signup), [Cloudflare](https://dash.cloudflare.com/sign-up),
[Supabase](https://supabase.com/dashboard) and [Google AI Studio](https://aistudio.google.com) account, plus Telegram.
Open Notepad and keep a private `catatku-keys.txt` for the codes you collect along the way.

### 1. Create the database (Supabase)

1. Click **New project**. Name it `catatku`, set a database password, and pick region **Southeast Asia (Singapore)**. Wait about 2 minutes.
2. Open **SQL Editor → New query**. Paste the whole of `supabase/migrations/20260928000000_init.sql` (open it in Notepad,
   then Ctrl+A, Ctrl+C) and click **Run**. You should see "Success. No rows returned".
3. Copy the **Project URL** (`https://….supabase.co`, under **Project Settings → Data API**) and a **secret key**
   (`sb_secret_…`, under **Project Settings → API Keys**). The secret key bypasses database security; never share it.

### 2. Get a Gemini API key

In [Google AI Studio](https://aistudio.google.com/apikey), click **Create API key**. The model is `gemini-flash-latest`
(always the current Flash model); you can pin a specific one in `worker/wrangler.jsonc`.

> Privacy note: on Gemini's **free tier**, Google may use your prompts to improve its products. That includes your
> transaction texts and receipt images. Enabling billing on the key stops this; typical personal use costs cents per month.

### 3. Create the Telegram bot

1. Chat with [@BotFather](https://t.me/BotFather) and send `/newbot`. Pick a name, then a username ending in `bot`. Copy the **token**.
2. Get your numeric Telegram ID from [@userinfobot](https://t.me/userinfobot).

### 4. Put the code on GitHub

1. On GitHub, click **New repository**. Name it `catatku`, choose **Private**, and click **Create repository**.
2. On the empty repository page, click **uploading an existing file**.
3. Open `Documents\Claude\catatku` in File Explorer, select everything inside it (`supabase`, `web`, `worker`, `README.md`,
   `.gitignore`), and drag it onto the GitHub page. Don't upload `node_modules` folders if you have any.
4. Click **Commit changes**.

### 5. Let Cloudflare build and deploy it

1. In the [Cloudflare dashboard](https://dash.cloudflare.com), go to **Workers & Pages → Create → Import a repository**.
2. Connect your GitHub account (allow access to just the `catatku` repository) and select it.
3. Fill in the build settings:

   | Setting | Value |
   |---|---|
   | Project name | `catatku` (must match `name` in `worker/wrangler.jsonc`) |
   | Build command | `npm ci && npm run build:web` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory (under advanced settings) | `worker` |

4. Click **Create and deploy** and wait 3–5 minutes. Your Worker's link is shown on its page, e.g.
   `https://catatku.<you>.workers.dev`. The first time, Cloudflare may ask you to pick your `workers.dev` subdomain.

From now on, every change you commit on GitHub is built and deployed automatically.

### 6. Add your secrets in Cloudflare

Open **Workers & Pages → catatku → Settings → Variables and Secrets**. For each row, click **Add**, choose type **Secret**,
paste the value, and save (**Deploy**).

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret key |
| `GEMINI_API_KEY` | Gemini key |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `ALLOWED_TELEGRAM_IDS` | Your Telegram ID (comma-separate several). **Set this**, or anyone who finds your bot can use it and spend your AI quota. |
| `SESSION_SECRET` | Any long random text (signs dashboard logins) |
| `TELEGRAM_WEBHOOK_SECRET` | Any long random text, letters/digits/`_`/`-` only. Also the password for the setup page. |

The Setup Map artifact has a button that generates random values for the last two.

### 7. Run the setup page

Open `https://catatku.<you>.workers.dev/setup`, paste your `TELEGRAM_WEBHOOK_SECRET`, and click **Check & connect**. It checks every
secret, tests the database, connects Telegram to your Worker, and installs the bot's command menu. Fix anything marked ✗ and run
it again; running it more than once is safe.

### 8. Use it

Open your bot in Telegram and send `/start`. Then try:

```
/saldoawal 2jt
/budget 3jt
Beli makan siang 50rb
Gaji masuk 10jt
Ingatkan bayar listrik tanggal 25 jam 9 pagi
/dashboard
```

`/dashboard` sends a one-time login link (valid for 10 minutes). The session then lasts 30 days on that browser.

## Bot commands

| Command | Action |
|---|---|
| `/saldo` | Balance, budget status, and debts |
| `/laporan [YYYY-MM]` | Monthly report by category |
| `/budget 3jt` | Set the monthly budget (`0` turns it off) |
| `/saldoawal 1,5jt` | Starting balance before you began tracking |
| `/pengingat` | Active reminders |
| `/batal <id>` | Cancel a reminder |
| `/hapus <id>` / `/undo` | Delete a transaction / delete the last transaction |
| `/dashboard` | Dashboard login link |
| `/zona WITA` | Change timezone: `WIB`, `WITA`, `WIT` or any name like `Asia/Singapore` |

Commands that take no argument also work without the slash: `saldo`, `laporan`, `undo`, `dashboard`, `help`.

## How it works

**Ledger semantics.** The balance is always computed from the ledger (`public.get_balance`), never stored:
`initial_balance + income − expense + borrow − repay − lend + collect`. Transfers move money between your own
wallets, so they don't change the total. **Total debt** = borrowed − repaid; **receivables** = lent − collected.

**AI parsing.** Every message becomes one Gemini call with a strict JSON schema (`responseJsonSchema`, generated from zod).
The response is validated with zod before anything is written. A deterministic Indonesian amount parser guards against the
classic LLM mistake of dropping a multiplier (returning `50` for `50rb`). Categories chosen by the model are mapped onto real
categories, falling back to "Lainnya" when nothing matches.

**Webhook, not long polling.** Cloudflare has no always-on processes, so Telegram pushes updates to `/telegram/webhook`.
Only requests carrying the secret header are accepted. The Worker replies `200` immediately and does the AI work in
`waitUntil`, so Telegram never times out and re-sends the same message.

**Reminders.** A Cron Trigger fires every minute. `claim_due_reminders()` atomically claims due rows (`FOR UPDATE SKIP LOCKED`,
and it reclaims rows stuck from a crashed run). After each send, `finish_reminder()` records the result and schedules the next
occurrence of recurring reminders from the original anchor, in the user's timezone, so "the 31st at 09:00" stays correct
across short months. Failed sends retry with backoff; if the user has blocked the bot, the reminder is marked failed.

**Dashboard auth.** `/dashboard` stores only a SHA-256 hash of a random token. Opening the link shows a confirmation page, and the
token is consumed on the **POST**, so link-preview bots can't burn it. The session is an HS256 JWT in an `HttpOnly; Secure;
SameSite=Lax` cookie. State-changing API calls must send JSON, which blocks form-based cross-site requests. Every API query is
scoped to the session's user.

**Database security.** RLS is enabled on every table with no policies, and all functions are revoked from `anon`/`authenticated`.
The public anon or publishable key can't read or change anything; only the Worker's secret key can.

## Changing things later

Edit a file on GitHub (open it and click the ✏️ pencil), then **Commit changes**. Cloudflare rebuilds and redeploys in a few
minutes. Useful settings in `worker/wrangler.jsonc`: `DEFAULT_TIMEZONE` (e.g. `Asia/Makassar`), `GEMINI_MODEL`, and
`GEMINI_THINKING_LEVEL` (`LOW` by default: lower is faster, higher is more careful).

## Command-line alternative (optional)

If you prefer a terminal to the GitHub + Cloudflare dashboard flow, you can deploy from your own computer with Node.js 20+.
The bot still runs on Cloudflare afterwards; your computer is only used to upload it.

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put SUPABASE_URL   # repeat for each secret in step 6
npm run deploy
```

Then open `/setup` as in step 7.

### Local development

```bash
# terminal 1 — API + bot on http://localhost:8787
cd worker
cp .dev.vars.example .dev.vars    # fill in real values
npm run dev

# terminal 2 — dashboard with hot reload on http://localhost:3000 (proxies /api and /auth to :8787)
cd web
npm install
npm run dev
```

Telegram can't reach `localhost`, so test the bot against the deployed Worker. To open the local dashboard, mint a login link
directly; the user must already exist, so message the deployed bot once first.

```bash
npm run login-link -- <your_telegram_id>
```

Checks: `cd worker && npm run typecheck && npm test`, and `cd web && npm run typecheck && npm run build`.

## Free-tier limits and troubleshooting

| Limit | Impact | What to do |
|---|---|---|
| Supabase free projects **pause after ~7 days of inactivity** | The bot stops answering | Use it regularly, or click **Restore** in Supabase; any paid plan removes this |
| Workers free plan: 100k requests/day, **10 ms CPU** per request | Plenty for personal use. AI and database waiting time doesn't count toward CPU | If you see `Exceeded CPU` in the logs, the $5/month Workers Paid plan raises the limit |
| `waitUntil` work continues ~30 s after the response | Gemini usually answers in 2–10 s | If receipts time out, pin a faster model, e.g. a Flash-Lite model |
| Gemini free-tier rate limits | Occasional "AI sedang tidak bisa memproses" replies | Wait and retry, or enable billing on the key |

- **Anything not working:** open `/setup` again. It lists exactly which setting is missing or wrong.
- **The Cloudflare build failed:** open **Workers & Pages → catatku → Deployments** and view the build log. The usual causes are
  the root directory not set to `worker`, or a project name other than `catatku`.
- **The bot replies "⛔ Bot ini privat" with a number:** put exactly that number in the `ALLOWED_TELEGRAM_IDS` secret.
- **See what the bot is doing:** **Workers & Pages → catatku → Logs → Live**, then send the bot a message.
- **"Link sudah dipakai atau kedaluwarsa":** send `/dashboard` again. Links expire after 10 minutes and work once.
- **Wrong dates or times:** send `/zona WITA` (or `WIB`/`WIT`) to the bot.
