import { GoogleGenAI, type Part, type ThinkingLevel } from "@google/genai";
import { z } from "zod";
import type { Env } from "../env";

// ---------------------------------------------------------------------------
// Structured-output schemas (validated with zod, sent to Gemini as JSON Schema)
// ---------------------------------------------------------------------------

export const ParsedTransaction = z.object({
  type: z.enum(["expense", "income", "transfer", "debt"]),
  amount: z.number().describe("Nominal in full units, e.g. 50rb -> 50000, 1,5jt -> 1500000. Always positive."),
  category: z.string().describe("Exactly one name from the provided category list."),
  description: z.string().describe("Short description in the user's language, e.g. 'Makan siang'."),
  transaction_date: z.string().describe("ISO 8601 local datetime without offset, e.g. 2026-09-27T12:30:00."),
  payment_method: z.string().describe("One of the provided payment methods; 'Tunai' if unknown."),
  merchant: z.string().nullable().describe("Shop/merchant/employer if mentioned, else null."),
  debt_direction: z
    .enum(["borrow", "repay", "lend", "collect"])
    .nullable()
    .describe("Only for type=debt: borrow=user borrowed/owes, repay=user paid back, lend=user lent out, collect=user got repaid. Null otherwise."),
  counterparty: z.string().nullable().describe("Other person for debts/transfers, e.g. 'Budi'. Null if none."),
});
export type ParsedTransaction = z.infer<typeof ParsedTransaction>;

export const ParsedReminder = z.object({
  task: z.string().describe("What to remind, e.g. 'Bayar listrik'."),
  remind_at: z.string().describe("ISO 8601 local datetime without offset when the reminder must fire."),
  recurrence: z.enum(["none", "daily", "weekly", "monthly"]),
  amount: z.number().nullable().describe("Bill amount if mentioned, else null."),
});
export type ParsedReminder = z.infer<typeof ParsedReminder>;

export const MessageAnalysis = z.object({
  intent: z.enum(["transaction", "reminder", "question", "other"]),
  transactions: z.array(ParsedTransaction).describe("One entry per money movement; empty unless intent=transaction."),
  reminder: ParsedReminder.nullable().describe("Only when intent=reminder, else null."),
  reply: z.string().describe("For intent=other: a short helpful reply in the user's language. Otherwise an empty string."),
});
export type MessageAnalysis = z.infer<typeof MessageAnalysis>;

// transcript comes first: Gemini fills fields in order, so it transcribes before it analyses.
export const VoiceAnalysis = z.object({
  transcript: z.string().describe("Verbatim transcript of the voice note; empty if unintelligible."),
  ...MessageAnalysis.shape,
});
export type VoiceAnalysis = z.infer<typeof VoiceAnalysis>;

export const ReceiptItem = z.object({
  name: z.string(),
  quantity: z.number(),
  unit_price: z.number(),
  total_price: z.number(),
});

export const ReceiptData = z.object({
  is_receipt: z.boolean().describe("False if the image is not a receipt/invoice/proof of payment."),
  merchant_name: z.string(),
  items: z.array(ReceiptItem),
  subtotal: z.number().nullable(),
  tax: z.number().nullable().describe("PPN/PB1/tax amount, null if absent."),
  service_charge: z.number().nullable(),
  discount: z.number().nullable().describe("Total discount as a positive number, null if absent."),
  grand_total: z.number().describe("Final amount paid."),
  transaction_date: z.string().nullable().describe("ISO 8601 local datetime printed on the receipt, null if unreadable."),
  category: z.string().describe("Exactly one name from the provided expense categories."),
  payment_method: z.string().describe("One of the provided payment methods; 'Tunai' if unknown."),
  currency: z.string().describe("ISO currency code, e.g. IDR."),
});
export type ReceiptData = z.infer<typeof ReceiptData>;

export const FinancialInsight = z.object({
  health_score: z.number().describe("0-100 financial health score for the month."),
  status: z.enum(["excellent", "good", "fair", "poor"]),
  headline: z.string().describe("One punchy sentence."),
  summary: z.string().describe("2-4 sentences on spending habits this month."),
  highlights: z.array(z.string()).describe("2-4 notable observations with numbers."),
  recommendations: z.array(z.string()).describe("2-4 concrete, actionable tips."),
});
export type FinancialInsight = z.infer<typeof FinancialInsight>;

const Answer = z.object({ answer: z.string() });

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = [
  "Tunai", "Transfer Bank", "QRIS", "Kartu Debit", "Kartu Kredit",
  "GoPay", "OVO", "DANA", "ShopeePay", "LinkAja", "Lainnya",
];

const MONEY_RULES = `
AMOUNT RULES (Indonesian conventions):
- "k", "rb", "ribu", "rebu" = x1.000 (50rb = 50000, 35k = 35000, 2,5rb = 2500)
- "jt", "juta" = x1.000.000 (10jt = 10000000, 1,5jt = 1500000, 1.5 juta = 1500000)
- "M", "miliar" = x1.000.000.000
- Dots/commas in plain numbers are thousand separators: "50.000" = 50000, "Rp 1.250.000" = 1250000.
- Combined: "1jt 250rb" = 1250000. Amounts are always positive numbers in full units.`;

function transactionSystemPrompt(nowContext: string, categories: string[], currency: string): string {
  return `You are the parsing engine of a personal-finance Telegram bot used mostly by Indonesians.
Users write casually in Indonesian, English, or a mix (slang, typos, abbreviations).

Current time: ${nowContext}. Default currency: ${currency}.

Classify the message into one intent:
- "transaction": the user reports money that moved (spent, received, transferred, borrowed, lent, repaid).
- "reminder": the user asks to be reminded of something at a time ("ingatkan", "remind me", "jangan lupa ... tanggal ...").
- "question": the user asks about their own finances ("berapa pengeluaran bulan ini?", "saldo saya?", "habis berapa buat makan?").
- "other": greetings, thanks, unrelated chat, or unparseable text.

TRANSACTION RULES:
- One entry per money movement: "kopi 20rb dan roti 15rb" -> two expenses.
- type: expense (beli/bayar/jajan/makan/isi bensin/top up game), income (gaji/gajian/bonus/dapat/terima/dibayar/jual),
  transfer (moving money between the user's own accounts/wallets, e.g. "tarik tunai 500rb", "top up GoPay dari BCA 100rb"),
  debt (utang/hutang/pinjam/minjemin/bayar utang/dibayar utangnya).
- debt_direction: "utang ke Budi 100rb" / "pinjam uang Budi" = borrow; "bayar utang ke Budi" = repay;
  "Budi pinjam 100rb" / "minjemin Budi" = lend; "Budi bayar utang" / "Budi balikin uang" = collect.
- category: choose EXACTLY one name from this list: ${categories.join(" | ")}.
  Debts use "Utang Piutang"; transfers use "Transfer".
- payment_method: one of ${PAYMENT_METHODS.join(", ")}. Map brand names (BCA/Mandiri/BRI/BNI transfer -> "Transfer Bank",
  "gopay" -> "GoPay", "qris" -> "QRIS"). Use "Tunai" when not stated.
- transaction_date: resolve relative dates from the current time ("kemarin" = yesterday, "tadi pagi" = today ~08:00,
  "semalam" = yesterday ~20:00, "tgl 3" = the 3rd of this month, or last month if that date is in the future).
  Without a time, use the current local time of day. Output local time WITHOUT a timezone offset.
- description: short, natural, capitalised, in the user's language, without the amount.
${MONEY_RULES}

REMINDER RULES:
- remind_at: resolve from the current time. "tanggal 25 jam 9 pagi" = the next 25th at 09:00 (this month if still ahead, else next month).
  "besok" = tomorrow; "jam 7 malam" = 19:00; "nanti sore" = today 16:00. No time given -> 09:00.
  Output local time WITHOUT a timezone offset. It must be in the future.
- recurrence: "setiap bulan"/"tiap tanggal"/"monthly" -> monthly; "setiap minggu"/"tiap Senin" -> weekly; "setiap hari" -> daily; else none.
- task: short imperative, e.g. "Bayar listrik".

Always fill every field. Use empty arrays / null / empty strings for fields that don't apply.`;
}

function receiptSystemPrompt(nowContext: string, categories: string[]): string {
  return `You are a receipt OCR and extraction engine for an Indonesian personal-finance app.
Current time: ${nowContext}.

Read the image carefully (it may be a printed receipt, an e-commerce/ride-hailing screenshot, a bank transfer proof, or a QRIS payment proof).
- merchant_name: the store/brand name as printed.
- items: every purchased line item with quantity, unit_price, total_price. If only a line total is visible, quantity=1 and unit_price=total_price.
- tax (PPN, PB1, Pajak), service_charge (Service, SC), discount (Diskon, Potongan, Promo) as positive numbers or null.
- grand_total: the final amount actually paid (TOTAL / Grand Total / Total Bayar), after tax, service and discounts.
- Indonesian receipts use "." as thousand separator: "25.000" = 25000. Never return values in thousands.
- transaction_date: the date/time printed on the receipt as local ISO 8601 without offset, or null.
- category: choose EXACTLY one of: ${categories.join(" | ")}.
- payment_method: one of ${PAYMENT_METHODS.join(", ")} based on what's printed (CASH/TUNAI -> Tunai, DEBIT -> Kartu Debit, QRIS, etc.); "Tunai" if unknown.
- If the image is not a receipt or proof of payment, set is_receipt=false and use empty/zero values.`;
}

const INSIGHT_SYSTEM_PROMPT = `You are a friendly, candid personal-finance coach for Indonesian users.
Given a JSON snapshot of one month of the user's finances, assess their financial health and spending habits.
Write in Bahasa Indonesia, casual but professional. Use Rupiah formatting like "Rp 1,2 jt" or "Rp 350 rb".
Base every statement strictly on the numbers provided; never invent transactions.
Score guide: savings rate >= 20% and within budget -> 80-100; positive savings -> 60-79; roughly break-even -> 40-59; overspending or growing debt -> below 40.`;

const QUESTION_SYSTEM_PROMPT = `You answer questions about the user's own finances inside a Telegram bot.
Use ONLY the JSON data provided. Answer in the user's language, concisely (max ~6 lines), with Rupiah formatted like "Rp 125.000".
If the data can't answer the question, say so and suggest opening the dashboard.
Plain text only (no Markdown or HTML).`;

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------

export class AIError extends Error {}

type GeminiSchema = Record<string, unknown>;

/**
 * Convert zod's JSON Schema into Gemini's long-standing OpenAPI-style `responseSchema`
 * (STRING/NUMBER/…, `nullable`, `propertyOrdering`), which every Gemini model version accepts.
 */
function toGeminiSchema(node: Record<string, unknown>): GeminiSchema {
  const description = typeof node.description === "string" ? node.description : undefined;

  // Nullable written as anyOf: [X, {type: "null"}]
  if (Array.isArray(node.anyOf)) {
    const options = node.anyOf as Record<string, unknown>[];
    const nonNull = options.filter((o) => o.type !== "null");
    const inner = toGeminiSchema({ ...nonNull[0], ...(description ? { description } : {}) });
    return options.length > nonNull.length ? { ...inner, nullable: true } : inner;
  }

  let type = node.type as string | string[] | undefined;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes("null");
    type = type.find((t) => t !== "null");
  }

  const out: GeminiSchema = {};
  if (description) out.description = description;
  if (nullable) out.nullable = true;

  switch (type) {
    case "object": {
      const props = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
      out.type = "OBJECT";
      out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)]));
      out.propertyOrdering = Object.keys(props);
      if (Array.isArray(node.required)) out.required = node.required;
      break;
    }
    case "array":
      out.type = "ARRAY";
      out.items = toGeminiSchema((node.items ?? {}) as Record<string, unknown>);
      break;
    case "integer":
      out.type = "INTEGER";
      break;
    case "number":
      out.type = "NUMBER";
      break;
    case "boolean":
      out.type = "BOOLEAN";
      break;
    default:
      out.type = "STRING";
      if (Array.isArray(node.enum)) {
        out.format = "enum";
        out.enum = node.enum;
      }
  }
  return out;
}

const schemaCache = new WeakMap<z.ZodType, GeminiSchema>();
export function schemaFor(schema: z.ZodType): GeminiSchema {
  let s = schemaCache.get(schema);
  if (!s) {
    s = toGeminiSchema(z.toJSONSchema(schema) as Record<string, unknown>);
    schemaCache.set(schema, s);
  }
  return s;
}

// Gemini 3+ models take a thinking level; older ones (2.x) reject it. Remember per isolate once we learn which.
let thinkingUnsupported = false;
const RETRYABLE = /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|overloaded/i;

async function generate<S extends z.ZodType>(
  env: Env,
  schema: S,
  systemInstruction: string,
  parts: Part[],
  timeoutMs = 20_000,
): Promise<z.infer<S>> {
  if (!env.GEMINI_API_KEY) throw new AIError("GEMINI_API_KEY is not configured");
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const level = (env.GEMINI_THINKING_LEVEL || "").toUpperCase();
  const started = Date.now();

  const call = (withThinking: boolean, budgetMs: number) =>
    ai.models.generateContent({
      model: env.GEMINI_MODEL || "gemini-flash-latest",
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: schemaFor(schema),
        ...(withThinking ? { thinkingConfig: { thinkingLevel: level as ThinkingLevel } } : {}),
        abortSignal: AbortSignal.timeout(budgetMs),
      },
    });

  let text: string | undefined;
  let attempt = 0;
  for (;;) {
    const useThinking = Boolean(level) && !thinkingUnsupported;
    const remaining = Math.max(5_000, timeoutMs - (Date.now() - started));
    try {
      text = (await call(useThinking, remaining)).text;
      break;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (useThinking && /thinking/i.test(msg) && /400|INVALID_ARGUMENT|not supported/i.test(msg)) {
        thinkingUnsupported = true; // this model doesn't take a thinking level: retry without it
        continue;
      }
      // One quick retry for transient overload — only if there's still time left before Telegram's budget runs out.
      if (attempt === 0 && RETRYABLE.test(msg) && Date.now() - started < 10_000) {
        attempt++;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new AIError(`Gemini request failed: ${msg}`);
    }
  }

  if (!text) throw new AIError("Gemini returned an empty response");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AIError("Gemini returned invalid JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AIError(`Gemini output failed validation: ${parsed.error.message}`);
  return parsed.data;
}

type Opts = { nowContext: string; categories: string[]; currency: string };

export function analyzeMessage(env: Env, text: string, opts: Opts): Promise<MessageAnalysis> {
  return generate(env, MessageAnalysis, transactionSystemPrompt(opts.nowContext, opts.categories, opts.currency), [
    { text },
  ]);
}

/** Voice notes: Gemini transcribes and analyses in a single call. */
export function analyzeVoice(
  env: Env,
  audio: { base64: string; mimeType: string },
  opts: Opts,
): Promise<VoiceAnalysis> {
  return generate(
    env,
    VoiceAnalysis,
    `${transactionSystemPrompt(opts.nowContext, opts.categories, opts.currency)}

The message is a VOICE NOTE. First write exactly what was said into "transcript" (in the spoken language, numbers as spoken,
e.g. "beli makan siang lima puluh ribu"). Then analyse the transcript with all the rules above.
If the audio is silent or unintelligible, leave "transcript" empty and use intent "other".`,
    [{ inlineData: { data: audio.base64, mimeType: audio.mimeType } }, { text: "Transcribe and analyse this voice note." }],
    22_000,
  );
}

export function parseReceipt(
  env: Env,
  image: { base64: string; mimeType: string },
  opts: { nowContext: string; categories: string[]; caption?: string },
): Promise<ReceiptData> {
  const parts: Part[] = [{ inlineData: { data: image.base64, mimeType: image.mimeType } }];
  parts.push({
    text: opts.caption
      ? `Extract this receipt. The user's caption (may contain hints like category or payment method): "${opts.caption}"`
      : "Extract this receipt.",
  });
  return generate(env, ReceiptData, receiptSystemPrompt(opts.nowContext, opts.categories), parts, 22_000);
}

export async function generateInsight(env: Env, snapshot: unknown): Promise<FinancialInsight> {
  const insight = await generate(env, FinancialInsight, INSIGHT_SYSTEM_PROMPT, [
    { text: `Data keuangan bulan ini (JSON):\n${JSON.stringify(snapshot)}` },
  ]);
  insight.health_score = Math.max(0, Math.min(100, Math.round(insight.health_score)));
  return insight;
}

export async function answerQuestion(env: Env, question: string, data: unknown): Promise<string> {
  const res = await generate(env, Answer, QUESTION_SYSTEM_PROMPT, [
    { text: `Data (JSON):\n${JSON.stringify(data)}\n\nPertanyaan: ${question}` },
  ]);
  return res.answer;
}