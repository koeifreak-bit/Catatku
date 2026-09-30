"use client";

import { ArrowDownCircle, ArrowUpCircle, ArrowRight, HandCoins, Plus, ReceiptText, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Amount } from "@/components/amount";
import { BudgetCard } from "@/components/dashboard/budget-card";
import { CategoryChart, TrendChart } from "@/components/dashboard/charts";
import { InsightCard } from "@/components/dashboard/insight-card";
import { StatCard } from "@/components/dashboard/stat-card";
import { MonthPicker } from "@/components/month-picker";
import { useSession } from "@/components/session";
import { TransactionFormDialog } from "@/components/transaction-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { paths } from "@/lib/api";
import type { DashboardSummary } from "@/lib/types";
import { currentPeriod, formatDate, formatMoney } from "@/lib/utils";

function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

export default function DashboardPage() {
  const { user } = useSession();
  const [month, setMonth] = useState(() => currentPeriod(user.timezone));
  const [adding, setAdding] = useState(false);
  const { data: s, mutate } = useSWR<DashboardSummary>(paths.summary(month));
  const cur = user.currency;
  const name = user.first_name ?? user.username ?? "";

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Halo{name ? `, ${name}` : ""} 👋</h1>
          <p className="text-sm text-muted-foreground">Ringkasan keuanganmu, diperbarui otomatis.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker value={month} onChange={setMonth} timezone={user.timezone} />
          <Button onClick={() => setAdding(true)}>
            <Plus /> Tambah
          </Button>
        </div>
      </div>

      {!s ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[124px]" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total Saldo" value={formatMoney(s.balance, cur)} icon={<Wallet className="h-4 w-4" />} hint="semua waktu" />
            <StatCard
              label="Pengeluaran Bulan Ini"
              value={formatMoney(s.monthly_expense, cur)}
              icon={<ArrowDownCircle className="h-4 w-4" />}
              delta={pctChange(s.monthly_expense, s.prev_month_expense)}
              deltaGoodWhen="down"
              hint="vs bulan lalu"
            />
            <StatCard
              label="Pemasukan Bulan Ini"
              value={formatMoney(s.monthly_income, cur)}
              icon={<ArrowUpCircle className="h-4 w-4" />}
              delta={pctChange(s.monthly_income, s.prev_month_income)}
              deltaGoodWhen="up"
              hint="vs bulan lalu"
            />
            <StatCard
              label="Total Utang"
              value={formatMoney(s.total_debt, cur)}
              icon={<HandCoins className="h-4 w-4" />}
              hint={s.total_receivable > 0 ? `Piutang ${formatMoney(s.total_receivable, cur)}` : "tidak ada piutang"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <BudgetCard summary={s} onChanged={() => mutate()} />
            <InsightCard month={month} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <CategoryChart summary={s} />
            <TrendChart summary={s} />
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Transaksi Terbaru</CardTitle>
              <Link href="/transactions" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                Lihat semua <ArrowRight className="h-4 w-4" />
              </Link>
            </CardHeader>
            <CardContent>
              {s.recent_transactions.length === 0 ? (
                <EmptyState icon={<ReceiptText className="h-8 w-8" />} title="Belum ada transaksi">
                  Kirim pesan seperti <code>Beli makan siang 50rb</code> ke bot Telegram, atau klik Tambah.
                </EmptyState>
              ) : (
                <ul className="divide-y">
                  {s.recent_transactions.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 py-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-base" aria-hidden>
                        {t.category?.icon ?? "📦"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{t.description || t.merchant || "Transaksi"}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {t.category?.name ?? "Tanpa kategori"} · {formatDate(t.transaction_date, user.timezone)}
                          {t.source.endsWith("_receipt") && " · 🧾 struk"}
                        </p>
                      </div>
                      <Amount t={t} currency={cur} className="text-sm" />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <TransactionFormDialog open={adding} onClose={() => setAdding(false)} onSaved={() => mutate()} />
    </div>
  );
}
