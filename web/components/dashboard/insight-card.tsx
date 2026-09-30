"use client";

import { AlertTriangle, CheckCircle2, Lightbulb, RefreshCw, Sparkles, TrendingUp } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { api, paths } from "@/lib/api";
import type { InsightResponse } from "@/lib/types";
import { formatDate } from "@/lib/utils";

const STATUS = {
  excellent: { label: "Sangat sehat", color: "var(--status-good)", Icon: CheckCircle2 },
  good: { label: "Sehat", color: "var(--status-good)", Icon: CheckCircle2 },
  fair: { label: "Perlu perhatian", color: "var(--status-warning)", Icon: AlertTriangle },
  poor: { label: "Kurang sehat", color: "var(--status-critical)", Icon: AlertTriangle },
} as const;

export function InsightCard({ month }: { month: string }) {
  // Insights are cached server-side per month; don't poll the LLM.
  const { data, error, isLoading, mutate } = useSWR<InsightResponse>(paths.insights(month), {
    refreshInterval: 0,
    revalidateOnFocus: false,
  });
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await mutate(await api.insights(month, true), { revalidate: false });
    } finally {
      setRefreshing(false);
    }
  }

  const insight = data?.insight;
  const s = insight ? STATUS[insight.status] : null;

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Ringkasan Kesehatan Keuangan
          </CardTitle>
          <CardDescription>
            Analisis AI{data?.generated_at && !data.empty ? ` · ${formatDate(data.generated_at)}` : ""}
          </CardDescription>
        </div>
        {!data?.empty && (
          <Button variant="ghost" size="icon" onClick={refresh} disabled={refreshing || isLoading} aria-label="Analisis ulang">
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        {isLoading || refreshing ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">Analisis AI belum tersedia: {error.message}</p>
        ) : insight && s ? (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              {!data?.empty && (
                <div className="text-center">
                  <p className="text-3xl font-semibold leading-none">{insight.health_score}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">skor</p>
                </div>
              )}
              <div className="min-w-0">
                {!data?.empty && (
                  <p className="inline-flex items-center gap-1.5 text-sm font-medium">
                    <s.Icon className="h-4 w-4" style={{ color: s.color }} aria-hidden /> {s.label}
                  </p>
                )}
                <p className="font-medium">{insight.headline}</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{insight.summary}</p>
            {insight.highlights.length > 0 && (
              <ul className="space-y-1.5 text-sm">
                {insight.highlights.map((h) => (
                  <li key={h} className="flex gap-2">
                    <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    {h}
                  </li>
                ))}
              </ul>
            )}
            {insight.recommendations.length > 0 && (
              <div className="rounded-md bg-muted p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                  <Lightbulb className="h-4 w-4" aria-hidden /> Saran
                </p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {insight.recommendations.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
