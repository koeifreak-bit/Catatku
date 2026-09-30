"use client";

import { PieChart as PieIcon, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import type { DashboardSummary } from "@/lib/types";
import { cn, compactMoney, formatMoney, monthLabel, todayKey } from "@/lib/utils";

/*
 * Chart conventions (dataviz reference): one series colour (--chart-series-1), recessive grid/axes,
 * 4px rounded bar ends, 2px lines, hover tooltips on every mark, single y-axis only.
 */
const SERIES = "var(--chart-series-1)";
const REFERENCE = "var(--chart-reference)";
const GRID = "var(--chart-grid)";
const AXIS = "var(--chart-axis)";
const TICK = { fill: AXIS, fontSize: 12 };

function TooltipBox({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-md">{children}</div>;
}

// ---------------------------------------------------------------------------
// Expense by category — ranked horizontal bars (magnitude comparison), top 7 + "Lainnya"
// ---------------------------------------------------------------------------

export function CategoryChart({ summary }: { summary: DashboardSummary }) {
  const cur = summary.currency;
  const data = useMemo(() => {
    const rows = summary.category_breakdown.map((c) => ({ ...c, label: `${c.icon} ${c.name}` }));
    if (rows.length <= 8) return rows;
    const top = rows.slice(0, 7);
    const rest = rows.slice(7);
    const total = rest.reduce((s, r) => s + r.total, 0);
    return [
      ...top,
      {
        category_id: null,
        name: `Lainnya (${rest.length} kategori)`,
        label: `➕ ${rest.length} kategori lain`,
        icon: "➕",
        color: "",
        total,
        count: rest.reduce((s, r) => s + r.count, 0),
        percent: Math.round(rest.reduce((s, r) => s + r.percent, 0) * 10) / 10,
      },
    ];
  }, [summary.category_breakdown]);

  const renderTooltip = ({ active, payload }: TooltipProps<number, string>) => {
    const row = active && payload?.[0]?.payload;
    if (!row) return null;
    return (
      <TooltipBox>
        <p className="font-medium">{row.label}</p>
        <p className="tabular mt-1">{formatMoney(row.total, cur)}</p>
        <p className="text-muted-foreground">
          {row.percent.toLocaleString("id-ID")}% · {row.count} transaksi
        </p>
      </TooltipBox>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PieIcon className="h-4 w-4 text-muted-foreground" /> Pengeluaran per Kategori
        </CardTitle>
        <CardDescription>
          {monthLabel(summary.period)} · total {formatMoney(summary.monthly_expense, cur)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyState icon={<PieIcon className="h-8 w-8" />} title="Belum ada pengeluaran">
            Pengeluaran yang kamu catat akan dikelompokkan per kategori di sini.
          </EmptyState>
        ) : (
          <div style={{ height: Math.max(160, data.length * 40 + 16) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ top: 0, right: 72, bottom: 0, left: 0 }} barCategoryGap={10}>
                <CartesianGrid horizontal={false} stroke={GRID} />
                <XAxis type="number" hide domain={[0, "dataMax"]} />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={150}
                  tickLine={false}
                  axisLine={false}
                  tick={{ ...TICK, fill: "hsl(var(--foreground))" }}
                  tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
                />
                <Tooltip content={renderTooltip} cursor={{ fill: "hsl(var(--muted))" }} />
                <Bar dataKey="total" fill={SERIES} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
                  <LabelList
                    dataKey="total"
                    position="right"
                    formatter={(v: number) => compactMoney(v, cur)}
                    style={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Spending over the month — daily bars, or cumulative spend vs. a linear budget pace line
// ---------------------------------------------------------------------------

export function TrendChart({ summary }: { summary: DashboardSummary }) {
  const [mode, setMode] = useState<"daily" | "cumulative">(summary.budget ? "cumulative" : "daily");
  const cur = summary.currency;
  const days = summary.daily.length;

  const data = useMemo(() => {
    let running = 0;
    const today = todayKey(summary.timezone);
    return summary.daily.map((d, i) => {
      running += d.expense;
      return {
        day: Number(d.date.slice(8, 10)),
        date: d.date,
        expense: d.expense,
        income: d.income,
        // Don't draw the cumulative line into the future.
        cumulative: d.date <= today ? running : null,
        pace: summary.budget ? Math.round((summary.budget.amount * (i + 1)) / days) : null,
      };
    });
  }, [summary.daily, summary.budget, summary.timezone, days]);

  const hasSpend = summary.daily.some((d) => d.expense > 0);

  const renderTooltip = ({ active, payload }: TooltipProps<number, string>) => {
    const row = active && payload?.[0]?.payload;
    if (!row) return null;
    const date = new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short" }).format(
      new Date(`${row.date}T00:00:00`),
    );
    return (
      <TooltipBox>
        <p className="font-medium">{date}</p>
        {mode === "daily" ? (
          <>
            <p className="tabular mt-1">Pengeluaran: {formatMoney(row.expense, cur)}</p>
            {row.income > 0 && <p className="tabular text-muted-foreground">Pemasukan: {formatMoney(row.income, cur)}</p>}
          </>
        ) : (
          <>
            {row.cumulative !== null && <p className="tabular mt-1">Total terpakai: {formatMoney(row.cumulative, cur)}</p>}
            {row.pace !== null && <p className="tabular text-muted-foreground">Batas ideal: {formatMoney(row.pace, cur)}</p>}
          </>
        )}
      </TooltipBox>
    );
  };

  const axisProps = {
    tickLine: false,
    axisLine: { stroke: GRID },
    tick: TICK,
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" /> Tren Pengeluaran
          </CardTitle>
          <CardDescription>{mode === "daily" ? "Pengeluaran per hari" : "Akumulasi pengeluaran vs. laju budget"}</CardDescription>
        </div>
        <div className="inline-flex rounded-md border p-0.5 text-xs" role="tablist" aria-label="Mode grafik">
          {(["daily", "cumulative"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded px-2.5 py-1 font-medium",
                mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "daily" ? "Harian" : "Kumulatif"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {!hasSpend ? (
          <EmptyState icon={<TrendingUp className="h-8 w-8" />} title="Belum ada data bulan ini" />
        ) : (
          <>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                {mode === "daily" ? (
                  <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
                    <CartesianGrid vertical={false} stroke={GRID} />
                    <XAxis dataKey="day" {...axisProps} interval="preserveStartEnd" minTickGap={12} />
                    <YAxis {...axisProps} axisLine={false} width={72} tickFormatter={(v: number) => compactMoney(v, cur)} />
                    <Tooltip content={renderTooltip} cursor={{ fill: "hsl(var(--muted))" }} />
                    <Bar dataKey="expense" fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                  </BarChart>
                ) : (
                  <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke={GRID} />
                    <XAxis dataKey="day" {...axisProps} interval="preserveStartEnd" minTickGap={12} />
                    <YAxis {...axisProps} axisLine={false} width={72} tickFormatter={(v: number) => compactMoney(v, cur)} />
                    <Tooltip content={renderTooltip} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
                    {summary.budget && (
                      <Line
                        dataKey="pace"
                        stroke={REFERENCE}
                        strokeWidth={2}
                        strokeDasharray="6 4"
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                      />
                    )}
                    <Line
                      dataKey="cumulative"
                      stroke={SERIES}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 5, strokeWidth: 2, stroke: "hsl(var(--card))" }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
            {mode === "cumulative" && (
              <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground" aria-label="Legenda">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-5 rounded" style={{ background: SERIES }} /> Total terpakai
                </span>
                {summary.budget ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-5 border-t-2 border-dashed" style={{ borderColor: REFERENCE }} /> Batas ideal (budget ÷ hari)
                  </span>
                ) : (
                  <span>Atur budget untuk melihat garis batas ideal.</span>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
