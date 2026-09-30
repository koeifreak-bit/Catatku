import type { ReminderRow, TransactionRow, UserRow } from "../lib/db";
import { formatLocal, monthLabel, parsePeriod, safeTz } from "../lib/dates";
import { formatMoney } from "../lib/money";
import type { ReceiptData } from "../services/ai";
import type { DashboardSummary } from "../services/finance";

/** Telegram HTML parse mode is far less brittle than MarkdownV2 escaping; only &, < and > need escaping. */
export function esc(s: string | number | null | undefined): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TYPE_LABEL: Record<string, string> = {
  expense: "Pengeluaran",
  income: "Pemasukan",
  transfer: "Transfer",
  debt: "Utang/Piutang",
};

const DEBT_LABEL: Record<string, string> = {
  borrow: "Utang ke",
  repay: "Bayar utang ke",
  lend: "Piutang ke",
  collect: "Terima bayaran utang dari",
};

export function progressBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function sign(t: TransactionRow): string {
  if (t.type === "income") return "+";
  if (t.type === "expense") return "−";
  if (t.type === "debt") return t.debt_direction === "borrow" || t.debt_direction === "collect" ? "+" : "−";
  return "";
}

export function transactionLine(t: TransactionRow, user: UserRow): string {
  const icon = esc(t.category?.icon ?? "📦");
  const who = t.type === "debt" && t.counterparty ? ` (${DEBT_LABEL[t.debt_direction ?? "borrow"]} ${esc(t.counterparty)})` : "";
  return `${icon} <b>${esc(t.description || TYPE_LABEL[t.type])}</b>${who} — <b>${sign(t)}${formatMoney(t.amount, user.currency)}</b>`;
}

export function budgetBlock(summary: DashboardSummary, user: UserRow): string {
  const lines = [`💰 Saldo: <b>${formatMoney(summary.balance, user.currency)}</b>`];
  const { year, month } = parsePeriod(summary.period, safeTz(user.timezone));
  if (summary.budget) {
    const b = summary.budget;
    const status = b.percent >= 100 ? "🚨 Budget terlampaui!" : b.percent >= 80 ? "⚠️ Hampir habis" : "✅ Aman";
    lines.push(
      `📊 Budget ${monthLabel(year, month)}: ${formatMoney(b.spent, user.currency)} / ${formatMoney(b.amount, user.currency)} (${b.percent}%)`,
      `<code>${progressBar(b.percent)}</code> ${status}`,
      b.remaining >= 0
        ? `Sisa budget: <b>${formatMoney(b.remaining, user.currency)}</b>`
        : `Lebih: <b>${formatMoney(-b.remaining, user.currency)}</b>`,
    );
  } else {
    lines.push(`📉 Pengeluaran ${monthLabel(year, month)}: ${formatMoney(summary.monthly_expense, user.currency)}`);
    lines.push("<i>Atur budget bulanan dengan /budget 3jt</i>");
  }
  return lines.join("\n");
}

export function transactionConfirmation(txs: TransactionRow[], user: UserRow, summary: DashboardSummary): string {
  const tz = safeTz(user.timezone);
  const header = txs.length > 1 ? `✅ <b>${txs.length} transaksi tercatat</b>` : "✅ <b>Tercatat!</b>";
  const body = txs
    .map((t) =>
      [
        transactionLine(t, user),
        `   📂 ${esc(t.category?.name ?? "Tanpa kategori")} · 💳 ${esc(t.payment_method)}`,
        `   📅 ${formatLocal(t.transaction_date, tz)} · <code>#${t.id}</code>`,
      ].join("\n"),
    )
    .join("\n\n");
  return `${header}\n\n${body}\n\n${budgetBlock(summary, user)}`;
}

export function receiptSummary(t: TransactionRow, r: ReceiptData, user: UserRow, summary: DashboardSummary): string {
  const tz = safeTz(user.timezone);
  const cur = user.currency;
  const items = r.items.slice(0, 25).map((i) => {
    const qty = i.quantity !== 1 ? `${i.quantity}× ` : "";
    return `• ${qty}${esc(i.name)} — ${formatMoney(i.total_price, cur)}`;
  });
  if (r.items.length > 25) items.push(`<i>… dan ${r.items.length - 25} item lainnya</i>`);

  const fees: string[] = [];
  if (r.subtotal != null) fees.push(`Subtotal: ${formatMoney(r.subtotal, cur)}`);
  if (r.tax) fees.push(`Pajak: ${formatMoney(r.tax, cur)}`);
  if (r.service_charge) fees.push(`Service: ${formatMoney(r.service_charge, cur)}`);
  if (r.discount) fees.push(`Diskon: −${formatMoney(r.discount, cur)}`);

  return [
    "🧾 <b>Struk berhasil dibaca!</b>",
    "",
    `🏪 <b>${esc(r.merchant_name || "Merchant")}</b>`,
    `📅 ${formatLocal(t.transaction_date, tz)}`,
    `📂 ${esc(t.category?.name ?? "Tanpa kategori")} · 💳 ${esc(t.payment_method)}`,
    "",
    items.length ? items.join("\n") : "<i>(item tidak terbaca)</i>",
    "",
    ...fees,
    `<b>Total: ${formatMoney(t.amount, cur)}</b>`,
    `<code>#${t.id}</code>`,
    "",
    budgetBlock(summary, user),
  ].join("\n");
}

export function reminderConfirmation(r: ReminderRow, user: UserRow): string {
  const rec = { none: "", daily: " (setiap hari)", weekly: " (setiap minggu)", monthly: " (setiap bulan)" }[r.recurrence];
  const amount = r.amount ? `\n💵 ${formatMoney(r.amount, user.currency)}` : "";
  return `⏰ <b>Pengingat disimpan</b>\n\n📝 ${esc(r.task)}${amount}\n🗓 ${formatLocal(r.remind_at, safeTz(user.timezone))}${rec}\n<code>#${r.id}</code> · batalkan dengan /batal ${r.id}`;
}

export function reminderNotification(r: ReminderRow, tz: string, currency: string): string {
  const amount = r.amount ? `\n💵 ${formatMoney(r.amount, currency)}` : "";
  const rec = r.recurrence !== "none" ? "\n🔁 Pengingat berulang" : "";
  return `🔔 <b>Pengingat!</b>\n\n📝 ${esc(r.task)}${amount}\n🗓 ${formatLocal(r.remind_at, tz)}${rec}`;
}

export function monthlyReport(summary: DashboardSummary, user: UserRow): string {
  const cur = user.currency;
  const { year, month } = parsePeriod(summary.period, safeTz(user.timezone));
  const cats = summary.category_breakdown
    .slice(0, 8)
    .map((c) => `${esc(c.icon)} ${esc(c.name)}: ${formatMoney(c.total, cur)} (${c.percent}%)`);
  return [
    `📈 <b>Laporan ${monthLabel(year, month)}</b>`,
    "",
    `⬆️ Pemasukan: <b>${formatMoney(summary.monthly_income, cur)}</b>`,
    `⬇️ Pengeluaran: <b>${formatMoney(summary.monthly_expense, cur)}</b>`,
    `🟰 Selisih: <b>${formatMoney(summary.net_monthly, cur)}</b>`,
    `🧾 ${summary.transaction_count} transaksi`,
    summary.total_debt > 0 ? `🤝 Utang aktif: ${formatMoney(summary.total_debt, cur)}` : "",
    summary.total_receivable > 0 ? `🤲 Piutang: ${formatMoney(summary.total_receivable, cur)}` : "",
    "",
    cats.length ? `<b>Pengeluaran per kategori</b>\n${cats.join("\n")}` : "<i>Belum ada pengeluaran bulan ini.</i>",
    "",
    budgetBlock(summary, user),
  ]
    .filter((l, i, arr) => l !== "" || arr[i - 1] !== "")
    .join("\n");
}

export const HELP_TEXT = `👋 <b>Catatku — asisten keuangan pribadi</b>

Cukup ketik seperti ngobrol:
• <code>Beli makan siang 50rb</code>
• <code>Gaji masuk 10jt</code>
• <code>Beli bensin 35k kemarin pakai GoPay</code>
• <code>Kopi 20rb dan roti 15rb</code>
• <code>Utang ke Budi 100rb</code> / <code>Bayar utang Budi 50rb</code>
• <code>Ingatkan bayar listrik tanggal 25 jam 9 pagi</code>
• <code>Berapa pengeluaran makan bulan ini?</code>
• 📸 Kirim foto struk untuk dicatat otomatis
• 🎤 Atau kirim voice note: <i>"beli bensin tiga puluh lima ribu"</i>

Perintah tanpa angka boleh diketik tanpa garis miring, mis. <code>saldo</code>, <code>laporan</code>, <code>undo</code>.

<b>Perintah</b>
/saldo — saldo & status budget
/laporan — laporan bulan ini
/budget 3jt — atur budget bulanan
/saldoawal 1,5jt — atur saldo awal
/pengingat — daftar pengingat aktif
/batal &lt;id&gt; — batalkan pengingat
/hapus &lt;id&gt; — hapus transaksi
/undo — hapus transaksi terakhir
/dashboard — link masuk ke dashboard web
/zona WITA — ganti zona waktu (WIB/WITA/WIT)`;
