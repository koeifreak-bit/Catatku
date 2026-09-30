import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Transaction, TxType } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMoney(value: number | null | undefined, currency = "IDR"): string {
  const v = Number(value ?? 0);
  if (currency === "IDR") {
    const s = Math.round(Math.abs(v)).toLocaleString("id-ID");
    return `${v < 0 ? "-" : ""}Rp ${s}`;
  }
  return new Intl.NumberFormat("id-ID", { style: "currency", currency }).format(v);
}

/** Compact axis/tooltip form: Rp 1,2 jt, Rp 350 rb. */
export function compactMoney(value: number, currency = "IDR"): string {
  if (currency !== "IDR") return new Intl.NumberFormat("id-ID", { notation: "compact", style: "currency", currency }).format(value);
  const a = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const fmt = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 1 });
  if (a >= 1e9) return `${sign}Rp ${fmt(a / 1e9)} M`;
  if (a >= 1e6) return `${sign}Rp ${fmt(a / 1e6)} jt`;
  if (a >= 1e3) return `${sign}Rp ${fmt(a / 1e3)} rb`;
  return `${sign}Rp ${Math.round(a)}`;
}

export function formatDate(iso: string, tz?: string, withTime = true): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: tz,
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(iso));
}

export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(new Date(y!, m! - 1, 1));
}

/** Today as YYYY-MM-DD in the given timezone (the user's, not the browser's). */
export function todayKey(tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Current month as YYYY-MM in the given timezone. */
export function currentPeriod(tz?: string): string {
  return todayKey(tz).slice(0, 7);
}

export function shiftPeriod(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Local datetime-local input value (YYYY-MM-DDTHH:mm) for an ISO instant in the given timezone. */
export function toLocalInput(iso: string, tz?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export const TYPE_LABEL: Record<TxType, string> = {
  expense: "Pengeluaran",
  income: "Pemasukan",
  transfer: "Transfer",
  debt: "Utang/Piutang",
};

export const DEBT_LABEL: Record<string, string> = {
  borrow: "Pinjam (utang)",
  repay: "Bayar utang",
  lend: "Meminjamkan",
  collect: "Terima pelunasan",
};

export const PAYMENT_METHODS = [
  "Tunai", "Transfer Bank", "QRIS", "Kartu Debit", "Kartu Kredit",
  "GoPay", "OVO", "DANA", "ShopeePay", "LinkAja", "Lainnya",
];

/** +1 / -1 / 0: the transaction's effect on the cash balance (mirrors public.signed_amount). */
export function balanceSign(t: Pick<Transaction, "type" | "debt_direction">): 1 | -1 | 0 {
  if (t.type === "income") return 1;
  if (t.type === "expense") return -1;
  if (t.type === "debt") return t.debt_direction === "borrow" || t.debt_direction === "collect" ? 1 : -1;
  return 0;
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, rb: 1e3, ribu: 1e3, rbu: 1e3, rebu: 1e3,
  jt: 1e6, juta: 1e6,
  m: 1e9, miliar: 1e9, milyar: 1e9,
};

/**
 * Read an amount typed the Indonesian way: "50.000", "50rb", "1,5jt", "Rp 1.250.000", "3 juta".
 * Returns null when there's no number. Mirrors the bot's parser (worker/src/lib/money.ts).
 */
export function parseAmountInput(input: string): number | null {
  const m = input.trim().toLowerCase().match(/^(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)\s*(ribu|rebu|rbu|rb|k|juta|jt|miliar|milyar|m)?$/);
  if (!m) return null;
  let s = m[1]!;
  if (s.includes(".") && s.includes(",")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
    s = s.replace(/[.,]/g, "");
  } else {
    s = s.replace(",", ".");
  }
  const value = Number(s) * (MULTIPLIERS[m[2] ?? ""] ?? 1);
  return Number.isFinite(value) ? value : null;
}