"use client";

import { AlertTriangle, CheckCircle2, OctagonAlert, Pencil, Target } from "lucide-react";
import { useState } from "react";
import { useSession } from "@/components/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { DashboardSummary } from "@/lib/types";
import { formatMoney, monthLabel, parseAmountInput } from "@/lib/utils";

function status(percent: number) {
  if (percent >= 100) return { label: "Terlampaui", color: "var(--status-critical)", Icon: OctagonAlert };
  if (percent >= 80) return { label: "Hampir habis", color: "var(--status-warning)", Icon: AlertTriangle };
  return { label: "Aman", color: "var(--status-good)", Icon: CheckCircle2 };
}

export function BudgetCard({ summary, onChanged }: { summary: DashboardSummary; onChanged: () => void }) {
  const { user, refreshUser } = useSession();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(user.monthly_budget || ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cur = summary.currency;
  const b = summary.budget;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseAmountInput(value || "0");
    if (amount === null) {
      setError("Jumlah tidak terbaca. Contoh: 3000000, 3.000.000, atau 3jt");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.updateMe({ monthly_budget: amount });
      await refreshUser();
      onChanged();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" /> Budget {monthLabel(summary.period)}
          </CardTitle>
          <CardDescription>Pengeluaran dibandingkan budget bulanan</CardDescription>
        </div>
        {!editing && (
          <Button variant="ghost" size="icon" onClick={() => setEditing(true)} aria-label="Ubah budget">
            <Pencil />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form onSubmit={save} className="grid gap-2">
            <div className="flex gap-2">
              <Input
                id="budget-input"
                autoFocus
                placeholder="3jt atau 3.000.000"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-label="Budget bulanan"
              />
              <Button type="submit" disabled={saving}>
                Simpan
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Batal
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </form>
        ) : b ? (
          <BudgetProgress b={b} currency={cur} />
        ) : (
          <div className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
            Belum ada budget. Klik ikon pensil, atau kirim <code className="rounded bg-card px-1">/budget 3jt</code> ke bot.
            <p className="mt-2">
              Pengeluaran bulan ini: <span className="font-medium text-foreground">{formatMoney(summary.monthly_expense, cur)}</span>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BudgetProgress({ b, currency }: { b: NonNullable<DashboardSummary["budget"]>; currency: string }) {
  const s = status(b.percent);
  const width = Math.min(100, Math.max(0, b.percent));
  return (
    <div>
      <div className="flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tracking-tight">{formatMoney(b.spent, currency)}</p>
        <p className="text-sm text-muted-foreground">dari {formatMoney(b.amount, currency)}</p>
      </div>
      <div
        className="mt-3 h-3 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(b.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Pemakaian budget"
      >
        <div className="h-full rounded-full transition-all" style={{ width: `${width}%`, background: s.color }} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <s.Icon className="h-4 w-4" style={{ color: s.color }} aria-hidden />
          {s.label} · {b.percent.toLocaleString("id-ID")}%
        </span>
        <span className="text-muted-foreground">
          {b.remaining >= 0 ? (
            <>
              Sisa <span className="font-medium text-foreground">{formatMoney(b.remaining, currency)}</span>
            </>
          ) : (
            <>
              Lebih <span className="font-medium text-expense">{formatMoney(-b.remaining, currency)}</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
