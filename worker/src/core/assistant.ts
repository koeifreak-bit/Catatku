/**
 * The bot's brain, independent of Telegram's API. The Telegram adapter (channels/telegram.ts)
 * turns updates into calls here and renders the returned `Reply` objects.
 */
import { Buffer } from "node:buffer";
import { type Env, publicUrl } from "../env";
import { createLoginToken } from "../lib/auth";
import type { CategoryRow, DB, TransactionRow, TxSource, UserRow } from "../lib/db";
import { aiNowContext, formatLocal, isZoneName, parseAiDateTime, safeTz, toLocal } from "../lib/dates";
import { correctUnitError, formatMoney, parseAmount } from "../lib/money";
import { type MessageAnalysis, analyzeMessage, analyzeVoice, answerQuestion, parseReceipt } from "../services/ai";
import {
  cancelReminder,
  createReminder,
  dashboardSummary,
  deleteTransaction,
  insertTransactions,
  lastTransaction,
  listCategories,
  listReminders,
  monthSnapshot,
  resolveCategory,
  updateUser,
} from "../services/finance";
import {
  HELP_TEXT,
  budgetBlock,
  esc,
  monthlyReport,
  receiptSummary,
  reminderConfirmation,
  transactionConfirmation,
} from "./format";

export interface ReplyButton {
  /** Callback payload, e.g. "del:123" (Telegram limit: 64 bytes). */
  id: string;
  title: string;
}

export interface Reply {
  /** Telegram-HTML subset: <b>, <i>, <code> and &amp; &lt; &gt; entities. */
  html: string;
  buttons?: ReplyButton[];
  link?: { text: string; url: string };
}

export interface ActionResult {
  /** Short popup confirmation shown on the tapped button. */
  toast: string;
  /** HTML appended to the original message when it is edited. */
  appendHtml?: string;
  /** Remove the buttons from the original message. */
  clearButtons?: boolean;
}

export interface AssistantContext {
  env: Env;
  db: DB;
  user: UserRow;
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const reply = (html: string, extra: Omit<Reply, "html"> = {}): Reply => ({ html, ...extra });

/** Transactions are past events; clamp model-resolved dates that land in the future to "now". */
function clampToNow(d: Date): Date {
  const now = Date.now();
  return d.getTime() > now + 5 * 60_000 ? new Date(now) : d;
}

function deleteButtons(txs: TransactionRow[]): ReplyButton[] {
  return txs.slice(0, 3).map((t) => ({ id: `del:${t.id}`, title: `🗑 Hapus #${t.id}` }));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Commands that also work without a leading slash (they take no argument, so they can't be confused with a transaction). */
const BARE_COMMANDS = new Set(["saldo", "laporan", "pengingat", "undo", "dashboard", "help", "bantuan", "menu", "start"]);

function parseCommand(text: string): { name: string; arg: string } | null {
  const slash = text.match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (slash) return { name: slash[1]!.toLowerCase(), arg: (slash[2] ?? "").trim() };
  const word = text.trim().toLowerCase();
  if (BARE_COMMANDS.has(word)) return { name: word, arg: "" };
  return null;
}

async function runCommand(ctx: AssistantContext, name: string, arg: string): Promise<Reply[]> {
  const { db, env } = ctx;
  let user = ctx.user;
  const cur = user.currency;

  switch (name) {
    case "start":
    case "help":
    case "bantuan":
    case "menu": {
      const hi = user.first_name ? `Halo, ${esc(user.first_name)}! ` : "Halo! ";
      return [reply(`${hi}${HELP_TEXT}`)];
    }

    case "saldo": {
      const summary = await dashboardSummary(db, user);
      const extra: string[] = [];
      if (summary.total_debt > 0) extra.push(`🤝 Utang aktif: ${formatMoney(summary.total_debt, cur)}`);
      if (summary.total_receivable > 0) extra.push(`🤲 Piutang: ${formatMoney(summary.total_receivable, cur)}`);
      return [reply([budgetBlock(summary, user), ...extra].join("\n"))];
    }

    case "laporan": {
      const summary = await dashboardSummary(db, user, /^\d{4}-\d{1,2}$/.test(arg) ? arg : null);
      return [reply(monthlyReport(summary, user))];
    }

    case "budget": {
      const amount = parseAmount(arg);
      if (amount === null) {
        const current = Number(user.monthly_budget);
        return [
          reply(
            `${current > 0 ? `Budget bulanan saat ini: <b>${formatMoney(current, cur)}</b>\n` : ""}Atur dengan: <code>/budget 3jt</code> (0 untuk menonaktifkan)`,
          ),
        ];
      }
      user = await updateUser(db, user.id, { monthly_budget: amount });
      const summary = await dashboardSummary(db, user);
      return [reply(`✅ Budget bulanan diatur ke <b>${formatMoney(amount, cur)}</b>\n\n${budgetBlock(summary, user)}`)];
    }

    case "saldoawal": {
      const amount = parseAmount(arg);
      if (amount === null) {
        return [reply("Atur saldo awal (uang yang kamu punya sebelum mulai mencatat): <code>/saldoawal 1,5jt</code>")];
      }
      const value = arg.startsWith("-") ? -amount : amount;
      user = await updateUser(db, user.id, { initial_balance: value });
      const summary = await dashboardSummary(db, user);
      return [reply(`✅ Saldo awal diatur ke <b>${formatMoney(value, cur)}</b>\n\n${budgetBlock(summary, user)}`)];
    }

    case "pengingat": {
      const reminders = await listReminders(db, user.id);
      if (!reminders.length) {
        return [reply("Belum ada pengingat aktif. Contoh: <code>Ingatkan bayar kos tiap tanggal 1 jam 8 pagi</code>")];
      }
      const tz = safeTz(user.timezone);
      const rec: Record<string, string> = { none: "", daily: " 🔁 harian", weekly: " 🔁 mingguan", monthly: " 🔁 bulanan" };
      const lines = reminders.map(
        (r) =>
          `<code>#${r.id}</code> ${esc(r.task)}${r.amount ? ` (${formatMoney(r.amount, cur)})` : ""}\n    🗓 ${formatLocal(r.remind_at, tz)}${rec[r.recurrence]}`,
      );
      return [reply(`⏰ <b>Pengingat aktif</b>\n\n${lines.join("\n")}\n\nBatalkan dengan /batal &lt;id&gt;`)];
    }

    case "batal": {
      const id = Number(arg.replace("#", ""));
      if (!Number.isInteger(id) || id <= 0) return [reply("Format: <code>/batal 12</code> (lihat ID di /pengingat)")];
      const ok = await cancelReminder(db, user.id, id);
      return [reply(ok ? `🗑 Pengingat <code>#${id}</code> dibatalkan.` : `Pengingat <code>#${id}</code> tidak ditemukan.`)];
    }

    case "hapus": {
      const id = Number(arg.replace("#", ""));
      if (!Number.isInteger(id) || id <= 0) return [reply("Format: <code>/hapus 123</code> (ID ada di pesan konfirmasi)")];
      const ok = await deleteTransaction(db, user.id, id);
      return [reply(ok ? `🗑 Transaksi <code>#${id}</code> dihapus.` : `Transaksi <code>#${id}</code> tidak ditemukan.`)];
    }

    case "undo": {
      const last = await lastTransaction(db, user.id);
      if (!last) return [reply("Belum ada transaksi untuk dihapus.")];
      await deleteTransaction(db, user.id, last.id);
      const summary = await dashboardSummary(db, user);
      return [
        reply(
          `↩️ Dihapus: <b>${esc(last.description)}</b> — ${formatMoney(last.amount, cur)} <code>#${last.id}</code>\n\n${budgetBlock(summary, user)}`,
        ),
      ];
    }

    case "dashboard": {
      const base = publicUrl(env);
      if (!base) return [reply("⚙️ PUBLIC_URL belum diatur di konfigurasi Worker.")];
      const token = await createLoginToken(db, user.id);
      return [
        reply("🔐 <b>Link masuk dashboard</b>\nBerlaku 10 menit dan hanya bisa dipakai sekali. Jangan bagikan ke orang lain.", {
          link: { text: "📊 Buka Dashboard", url: `${base}/auth/login?token=${encodeURIComponent(token)}` },
        }),
      ];
    }

    case "zona":
    case "timezone": {
      const zones: Record<string, string> = { wib: "Asia/Jakarta", wita: "Asia/Makassar", wit: "Asia/Jayapura" };
      const wanted = zones[arg.toLowerCase()] ?? arg;
      if (!arg || !isZoneName(wanted)) {
        const now = toLocal(new Date(), safeTz(user.timezone));
        return [
          reply(
            `🕘 Zona waktu saat ini: <b>${esc(user.timezone)}</b> (sekarang ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")})\nUbah dengan <code>/zona WIB</code>, <code>/zona WITA</code>, <code>/zona WIT</code>, atau nama lengkap seperti <code>/zona Asia/Singapore</code>.`,
          ),
        ];
      }
      user = await updateUser(db, user.id, { timezone: wanted });
      const now = toLocal(new Date(), wanted);
      return [
        reply(
          `✅ Zona waktu diubah ke <b>${esc(wanted)}</b>. Sekarang jam ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")} di sana.\n<i>Pengingat yang sudah ada tetap di jam aslinya.</i>`,
        ),
      ];
    }

    default:
      return [reply("Perintah tidak dikenal. Ketik /help untuk daftar perintah.")];
  }
}

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

export async function handleText(ctx: AssistantContext, rawText: string): Promise<Reply[]> {
  const text = rawText.trim();
  if (!text) return [];
  const cmd = parseCommand(text);
  if (cmd) return runCommand(ctx, cmd.name, cmd.arg);

  const { env, db, user } = ctx;
  const tz = safeTz(user.timezone);
  const categories = await listCategories(db, user.id);
  const analysis = await analyzeMessage(env, text, {
    nowContext: aiNowContext(tz),
    categories: categories.map((c) => c.name),
    currency: user.currency,
  });
  return actOn(ctx, text, analysis, categories, "telegram_text");
}

/** Voice notes: transcribed and analysed by Gemini in one call, then handled exactly like typed text. */
export async function handleVoice(ctx: AssistantContext, audio: { bytes: Uint8Array; mimeType: string }): Promise<Reply[]> {
  const { env, db, user } = ctx;
  if (audio.bytes.byteLength > MAX_IMAGE_BYTES) return [reply("📦 Voice note-nya terlalu panjang. Coba maksimal 2 menit ya.")];
  const tz = safeTz(user.timezone);
  const categories = await listCategories(db, user.id);
  const analysis = await analyzeVoice(
    env,
    { base64: toBase64(audio.bytes), mimeType: audio.mimeType },
    { nowContext: aiNowContext(tz), categories: categories.map((c) => c.name), currency: user.currency },
  );
  const transcript = analysis.transcript.trim();
  if (!transcript) return [reply("🎤 Maaf, suaranya kurang jelas. Coba rekam ulang atau ketik saja ya.")];
  const heard = reply(`🎤 <i>"${esc(transcript)}"</i>`);
  return [heard, ...(await actOn(ctx, transcript, analysis, categories, "telegram_voice"))];
}

async function actOn(
  ctx: AssistantContext,
  text: string,
  analysis: MessageAnalysis,
  categories: CategoryRow[],
  source: TxSource,
): Promise<Reply[]> {
  const { env, db, user } = ctx;
  const tz = safeTz(user.timezone);

  switch (analysis.intent) {
    case "transaction": {
      const parsed = analysis.transactions.filter((t) => t.amount > 0);
      if (!parsed.length) {
        return [reply("🤔 Aku belum menangkap nominalnya. Contoh: <code>Beli makan siang 50rb</code>")];
      }
      const inserted = await insertTransactions(
        db,
        user.id,
        parsed.map((t) => ({
          type: t.type,
          amount: parsed.length === 1 ? correctUnitError(t.amount, text) : t.amount,
          category_id: resolveCategory(categories, t.category, t.type)?.id ?? null,
          description: t.description,
          merchant: t.merchant,
          payment_method: t.payment_method,
          debt_direction: t.type === "debt" ? (t.debt_direction ?? "borrow") : null,
          counterparty: t.counterparty,
          transaction_date: clampToNow(parseAiDateTime(t.transaction_date, tz)).toISOString(),
          source,
          raw_input: text,
        })),
      );
      const summary = await dashboardSummary(db, user);
      return [reply(transactionConfirmation(inserted, user, summary), { buttons: deleteButtons(inserted) })];
    }

    case "reminder": {
      const r = analysis.reminder;
      if (!r) {
        return [reply("🤔 Kapan aku harus mengingatkan? Contoh: <code>Ingatkan bayar listrik tanggal 25 jam 9 pagi</code>")];
      }
      const at = parseAiDateTime(r.remind_at, tz, new Date(0));
      if (at.getTime() <= Date.now()) {
        return [reply(`⌛ Waktu ${esc(formatLocal(at, tz))} sudah lewat. Sebutkan tanggal/jam yang akan datang ya.`)];
      }
      const reminder = await createReminder(db, user, {
        task: r.task,
        remind_at: at.toISOString(),
        recurrence: r.recurrence,
        amount: r.amount && r.amount > 0 ? correctUnitError(r.amount, text) : null,
      });
      return [reply(reminderConfirmation(reminder, user))];
    }

    case "question": {
      const snapshot = await monthSnapshot(db, user);
      const answer = await answerQuestion(env, text, snapshot);
      return [reply(esc(answer))];
    }

    default: {
      const r = analysis.reply?.trim();
      return [reply(r ? esc(r) : "Ketik /help untuk melihat contoh pencatatan 🙂")];
    }
  }
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** Native base64 (nodejs_compat) — far cheaper on Worker CPU time than a JS loop for multi-MB photos. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export async function handleImage(
  ctx: AssistantContext,
  image: { bytes: Uint8Array; mimeType: string },
  caption?: string,
): Promise<Reply[]> {
  const { env, db, user } = ctx;
  if (image.bytes.byteLength > MAX_IMAGE_BYTES) return [reply("📦 Gambarnya terlalu besar (maks 10 MB).")];
  const tz = safeTz(user.timezone);
  const categories = await listCategories(db, user.id);
  const receipt = await parseReceipt(
    env,
    { base64: toBase64(image.bytes), mimeType: image.mimeType },
    {
      nowContext: aiNowContext(tz),
      categories: categories.filter((c) => c.type === "expense").map((c) => c.name),
      caption: caption?.trim() || undefined,
    },
  );

  if (!receipt.is_receipt || receipt.grand_total <= 0) {
    return [reply("🧐 Gambar ini tidak terbaca sebagai struk/bukti bayar. Coba foto lebih jelas dan tegak ya.")];
  }

  const { is_receipt: _ignored, ...receiptData } = receipt;
  const merchant = receipt.merchant_name?.trim() || null;
  const [tx] = await insertTransactions(db, user.id, [
    {
      type: "expense",
      amount: receipt.grand_total,
      category_id: resolveCategory(categories, receipt.category, "expense")?.id ?? null,
      description: merchant ? `Belanja di ${merchant}` : "Belanja (struk)",
      merchant,
      payment_method: receipt.payment_method,
      transaction_date: clampToNow(parseAiDateTime(receipt.transaction_date, tz)).toISOString(),
      source: "telegram_receipt",
      raw_input: caption?.trim() || null,
      receipt_data: receiptData,
    },
  ]);
  if (!tx) throw new Error("Receipt insert returned no row");
  const summary = await dashboardSummary(db, user);
  return [reply(receiptSummary(tx, receipt, user, summary), { buttons: deleteButtons([tx]) })];
}

// ---------------------------------------------------------------------------
// Button callbacks (del:<id>, snooze:<id>, done:<id>)
// ---------------------------------------------------------------------------

export async function handleAction(ctx: AssistantContext, data: string): Promise<ActionResult> {
  const { db, user } = ctx;
  const [action, rawId] = data.split(":");
  const id = Number(rawId);

  if (action === "del" && id) {
    const ok = await deleteTransaction(db, user.id, id);
    return ok
      ? { toast: `🗑 Transaksi #${id} dihapus`, appendHtml: `🗑 <b>Transaksi #${id} dihapus.</b>`, clearButtons: true }
      : { toast: `Transaksi #${id} sudah dihapus` };
  }

  if (action === "snooze" && id) {
    const { data: r } = await db.from("reminders").select("task,amount").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (!r) return { toast: "Pengingat tidak ditemukan" };
    const at = new Date(Date.now() + 60 * 60_000).toISOString();
    await createReminder(db, user, { task: r.task, remind_at: at, recurrence: "none", amount: r.amount });
    return { toast: "⏰ Oke, diingatkan lagi 1 jam lagi", clearButtons: true };
  }

  if (action === "done") return { toast: "👍 Mantap!", clearButtons: true };
  return { toast: "🤔 Aksi tidak dikenal" };
}

export const AI_FAILURE_TEXT = "😵 Maaf, AI sedang tidak bisa memproses pesanmu. Coba lagi sebentar lagi ya.";
export const GENERIC_FAILURE_TEXT = "⚠️ Terjadi kesalahan saat memproses pesan. Coba lagi ya.";
