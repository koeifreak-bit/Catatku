"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { currentPeriod, monthLabel, shiftPeriod } from "@/lib/utils";

export function MonthPicker({ value, onChange, timezone }: { value: string; onChange: (period: string) => void; timezone?: string }) {
  const isCurrent = value >= currentPeriod(timezone);
  return (
    <div className="inline-flex items-center gap-1 rounded-md border bg-card p-1">
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onChange(shiftPeriod(value, -1))} aria-label="Bulan sebelumnya">
        <ChevronLeft />
      </Button>
      <span className="min-w-32 text-center text-sm font-medium">{monthLabel(value)}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        disabled={isCurrent}
        onClick={() => onChange(shiftPeriod(value, 1))}
        aria-label="Bulan berikutnya"
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
