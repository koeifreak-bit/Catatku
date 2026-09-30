/**
 * Deterministic parsing/formatting of Indonesian money expressions.
 *
 * The LLM does the heavy lifting, but these helpers power bot commands
 * (`/budget 5jt`) and guard against unit mistakes in AI output
 * (e.g. the model returning 50 instead of 50.000 for "50rb").
 */

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  rb: 1_000,
  rbu: 1_000,
  ribu: 1_000,
  rebu: 1_000,
  jt: 1_000_000,
  juta: 1_000_000,
  m: 1_000_000_000,
  miliar: 1_000_000_000,
  milyar: 1_000_000_000,
};

const AMOUNT_RE =
  /(?<![\w.,])(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)(\s*)(ribu|rebu|rbu|rb|k|juta|jt|miliar|milyar|m)?(?![\w])/gi;

/** "50.000" -> 50000, "1,5" -> 1.5, "1.250.000,50" -> 1250000.5, "12.5" -> 12.5 */
export function toNumber(raw: string): number {
  let s = raw;
  if (s.includes(".") && s.includes(",")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    return Number(s);
  }
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""));
  s = s.replace(",", ".");
  if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, "");
  return Number(s);
}

/** Every money-like amount in `text`, with suffixes (rb/jt/…) applied. */
export function findAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const number = m[1] ?? "";
    const gap = m[2] ?? "";
    let suffix = (m[3] ?? "").toLowerCase();
    // A lone "m" only means miliar when glued to the number ("2m"), never as a separate word.
    if (suffix === "m" && gap.length > 0) suffix = "";
    const value = toNumber(number) * (MULTIPLIERS[suffix] ?? 1);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

export function parseAmount(text: string): number | null {
  const [first] = findAmounts(text);
  return first ?? null;
}

/**
 * Fix the classic LLM failure of dropping/duplicating a thousand/million multiplier.
 * Only applies when the text has exactly one explicit amount and the AI value differs
 * from it by an exact power-of-1000 factor; otherwise the AI value is trusted.
 */
export function correctUnitError(aiAmount: number, rawText: string): number {
  const amounts = findAmounts(rawText).filter((a) => a >= 1);
  if (amounts.length !== 1 || aiAmount <= 0) return aiAmount;
  const parsed = amounts[0]!;
  const ratio = parsed / aiAmount;
  for (const factor of [1_000, 1_000_000, 0.001, 0.000001]) {
    if (Math.abs(ratio - factor) / factor < 1e-9) return parsed;
  }
  return aiAmount;
}

export function formatMoney(value: number | string | null | undefined, currency = "IDR"): string {
  const v = Number(value ?? 0);
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (currency.toUpperCase() === "IDR") {
    return `${sign}Rp ${Math.round(abs).toLocaleString("en-US").replace(/,/g, ".")}`;
  }
  return `${sign}${currency.toUpperCase()} ${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
