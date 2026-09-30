import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  icon,
  delta,
  deltaGoodWhen = "down",
  hint,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  /** Percent change vs previous period (null = no comparison available). */
  delta?: number | null;
  deltaGoodWhen?: "up" | "down";
  hint?: string;
}) {
  const hasDelta = delta !== undefined && delta !== null && Number.isFinite(delta);
  const up = hasDelta && delta! > 0.05;
  const down = hasDelta && delta! < -0.05;
  const good = (up && deltaGoodWhen === "up") || (down && deltaGoodWhen === "down");
  const DeltaIcon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className="grid h-9 w-9 place-items-center rounded-full bg-muted text-muted-foreground">{icon}</span>
      </div>
      <p className="mt-2 truncate text-2xl font-semibold tracking-tight" title={value}>
        {value}
      </p>
      <div className="mt-1 flex min-h-5 items-center gap-1 text-xs">
        {hasDelta && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 font-medium",
              up || down ? (good ? "text-income" : "text-expense") : "text-muted-foreground",
            )}
          >
            <DeltaIcon className="h-3.5 w-3.5" aria-hidden />
            {Math.abs(delta!).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%
          </span>
        )}
        {hint && <span className="truncate text-muted-foreground">{hint}</span>}
      </div>
    </Card>
  );
}
