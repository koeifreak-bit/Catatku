import type { Transaction } from "@/lib/types";
import { balanceSign, cn, formatMoney } from "@/lib/utils";

/** Signed amount: the +/− sign carries the meaning; colour only reinforces it. */
export function Amount({ t, currency, className }: { t: Pick<Transaction, "type" | "debt_direction" | "amount">; currency: string; className?: string }) {
  const sign = balanceSign(t);
  return (
    <span
      className={cn(
        "tabular whitespace-nowrap font-medium",
        sign > 0 ? "text-income" : sign < 0 ? "text-expense" : "text-muted-foreground",
        className,
      )}
    >
      {sign > 0 ? "+" : sign < 0 ? "−" : "⇄ "}
      {formatMoney(t.amount, currency)}
    </span>
  );
}
