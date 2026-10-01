import { Bot, type Context, GrammyError, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
  AI_FAILURE_TEXT,
  type AssistantContext,
  GENERIC_FAILURE_TEXT,
  MAX_IMAGE_BYTES,
  type Reply,
  handleAction,
  handleImage,
  handleText,
  handleVoice,
} from "../core/assistant";
import { esc } from "../core/format";
import { type Env, ownerTelegramIds } from "../env";
import { getDb } from "../lib/db";
import { AIError } from "../services/ai";
import { accessFor, canUse, requestAccess } from "../services/access";
import { upsertTelegramUser } from "../services/finance";

type BotContext = Context & { assistant: AssistantContext };

const MAX_VOICE_SECONDS = 120;

function keyboard(r: Reply): InlineKeyboard | undefined {
  if (!r.buttons?.length && !r.link) return undefined;
  const kb = new InlineKeyboard();
  r.buttons?.forEach((b, i) => {
    kb.text(b.title, b.id);
    if (i % 2 === 1) kb.row();
  });
  if (r.link) kb.row().url(r.link.text, r.link.url);
  return kb;
}

const TELEGRAM_LIMIT = 4096;

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function send(ctx: BotContext, replies: Reply[]) {
  for (const r of replies) {
    const markup = keyboard(r);
    const extra = { link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) };
    if (r.html.length <= TELEGRAM_LIMIT) {
      await ctx.reply(r.html, { parse_mode: "HTML", ...extra });
      continue;
    }
    // Cutting HTML mid-tag makes Telegram reject the message, so very long replies go out as plain text chunks.
    const chunks = stripHtml(r.html).match(new RegExp(`[\\s\\S]{1,${TELEGRAM_LIMIT}}`, "g")) ?? [];
    for (let i = 0; i < chunks.length; i++) {
      await ctx.reply(chunks[i]!, i === chunks.length - 1 ? extra : { link_preview_options: { is_disabled: true } });
    }
  }
}

async function downloadFile(ctx: BotContext, token: string, fileId: string): Promise<Uint8Array> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file_path");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`Failed to download image: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Tell every owner that someone new wants to use the bot, with Allow / Decline buttons. */
async function notifyOwners(env: Env, ctx: BotContext, who: { id: number; name: string | null; username: string | null }) {
  const lines = [
    "👤 <b>Permintaan akses baru</b>",
    "",
    `Nama: <b>${esc(who.name || "(tanpa nama)")}</b>`,
    ...(who.username ? [`Username: @${esc(who.username)}`] : []),
    `ID: <code>${who.id}</code>`,
    "",
    "Izinkan dia memakai Catatku? Datanya akan terpisah dari datamu.",
  ];
  const kb = new InlineKeyboard().text("✅ Izinkan", `allow:${who.id}`).text("🚫 Tolak", `deny:${who.id}`);
  for (const owner of ownerTelegramIds(env)) {
    // An owner who has never opened the bot can't be messaged; the request still shows on the dashboard.
    await ctx.api.sendMessage(owner, lines.join("\n"), { parse_mode: "HTML", reply_markup: kb }).catch(() => undefined);
  }
}

function buildBot(env: Env): Bot<BotContext> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const bot = new Bot<BotContext>(token);

  // Error boundary. In webhook mode grammY never calls bot.catch() (handleUpdate just rethrows),
  // so failures are caught here and the user always gets a reply instead of silence.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error("Telegram handler error", { update: ctx.update.update_id, error: String(err) });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "⚠️ Gagal, coba lagi." }).catch(() => undefined);
      if (!ctx.chat) return;
      const text = err instanceof AIError ? AI_FAILURE_TEXT : err instanceof GrammyError ? "⚠️ Gagal mengirim balasan Telegram." : GENERIC_FAILURE_TEXT;
      await ctx.api.sendMessage(ctx.chat.id, text).catch(() => undefined);
    }
  });

  // Private chats only, allow-list, and attach the assistant context.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    if (ctx.chat && ctx.chat.type !== "private") return;
    const db = getDb(env);
    const access = await accessFor(env, db, from.id);
    if (!canUse(access)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "⛔ Akses belum diizinkan" }).catch(() => undefined);
      if (!ctx.message) return;
      if (access === "blocked") {
        await ctx.reply("⛔ Bot ini privat.");
      } else if (access === "pending") {
        await ctx.reply("⏳ Permintaan aksesmu masih menunggu persetujuan pemilik bot. Kamu akan dapat pesan begitu disetujui.");
      } else {
        const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || null;
        const isNew = await requestAccess(db, { telegramId: from.id, name, username: from.username ?? null });
        if (isNew) await notifyOwners(env, ctx, { id: from.id, name, username: from.username ?? null });
        await ctx.reply(
          `👋 Halo! Bot ini privat.\nPermintaan akses sudah dikirim ke pemiliknya. Kamu akan dapat pesan begitu disetujui.\n\nID Telegram kamu: ${from.id}`,
        );
      }
      return;
    }
    const user = await upsertTelegramUser(db, env, {
      telegramId: from.id,
      chatId: ctx.chat?.id ?? from.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
    });
    ctx.assistant = { env, db, user, isOwner: access === "owner" };
    await next();
  });

  bot.on("message:text", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    await send(ctx, await handleText(ctx.assistant, ctx.message.text));
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1); // largest size
    if (!photo) return;
    if (photo.file_size && photo.file_size > MAX_IMAGE_BYTES) {
      await send(ctx, [{ html: "📦 Gambarnya terlalu besar (maks 10 MB)." }]);
      return;
    }
    await ctx.replyWithChatAction("typing");
    const bytes = await downloadFile(ctx, token, photo.file_id);
    await send(ctx, await handleImage(ctx.assistant, { bytes, mimeType: "image/jpeg" }, ctx.message.caption));
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) {
      await send(ctx, [{ html: "📎 Kirim struk sebagai foto atau file gambar (JPG/PNG/WebP)." }]);
      return;
    }
    if (doc.file_size && doc.file_size > MAX_IMAGE_BYTES) {
      await send(ctx, [{ html: "📦 Gambarnya terlalu besar (maks 10 MB)." }]);
      return;
    }
    await ctx.replyWithChatAction("typing");
    const bytes = await downloadFile(ctx, token, doc.file_id);
    await send(ctx, await handleImage(ctx.assistant, { bytes, mimeType: doc.mime_type }, ctx.message.caption));
  });

  // Voice notes (and audio files): Gemini transcribes and logs them like typed text.
  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const media = ctx.message.voice ?? ctx.message.audio;
    if (!media) return;
    if (media.duration > MAX_VOICE_SECONDS) {
      await send(ctx, [{ html: `🎤 Voice note-nya terlalu panjang. Maksimal ${MAX_VOICE_SECONDS / 60} menit ya.` }]);
      return;
    }
    await ctx.replyWithChatAction("typing");
    const bytes = await downloadFile(ctx, token, media.file_id);
    await send(ctx, await handleVoice(ctx.assistant, { bytes, mimeType: media.mime_type || "audio/ogg" }));
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const result = await handleAction(ctx.assistant, data);
    await ctx.answerCallbackQuery({ text: result.toast });
    if (result.notify) {
      const { telegramId, html } = result.notify;
      await ctx.api
        .sendMessage(telegramId, html, { parse_mode: "HTML" })
        .catch((err) => console.warn("Could not notify user", { telegramId, error: String(err) }));
    }
    if (!result.appendHtml && !result.clearButtons && !result.removeAllButtons) return;

    const original = ctx.callbackQuery.message;
    // Keep the other buttons (e.g. the remaining 🗑 buttons of a multi-transaction message); drop only the tapped one.
    const rows = (original?.reply_markup?.inline_keyboard ?? [])
      .map((row) => row.filter((b) => !("callback_data" in b) || b.callback_data !== data))
      .filter((row) => row.length > 0);
    const markup: InlineKeyboardMarkup = {
      inline_keyboard: result.removeAllButtons || (result.clearButtons && !result.appendHtml) ? [] : rows,
    };

    if (result.appendHtml && original && "text" in original && original.text) {
      const text = `${esc(original.text)}\n\n${result.appendHtml}`;
      if (text.length <= TELEGRAM_LIMIT) {
        const edited = await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: markup }).then(() => true, () => false);
        if (edited) return;
      }
    }
    await ctx.editMessageReplyMarkup({ reply_markup: markup }).catch(() => undefined);
  });

  return bot;
}

let cachedBot: { token: string; bot: Promise<Bot<BotContext>> } | null = null;

/** A ready (initialised) bot instance, reused across requests in the same isolate. */
export function getTelegramBot(env: Env): Promise<Bot<BotContext>> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (cachedBot?.token === token) return cachedBot.bot;
  const promise = (async () => {
    const bot = buildBot(env);
    await bot.init(); // fetches getMe once per isolate
    return bot;
  })();
  promise.catch(() => {
    cachedBot = null;
  });
  cachedBot = { token, bot: promise };
  return promise;
}
