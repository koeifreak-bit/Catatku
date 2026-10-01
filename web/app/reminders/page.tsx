"use client";

import { BellPlus, BellRing, Repeat, Trash2 } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { useSession } from "@/components/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge, EmptyState, Skeleton } from "@/components/ui/misc";
import { api, paths } from "@/lib/api";
import type { Recurrence, Reminder } from "@/lib/types";
import { cn, formatDate, formatMoney, parseAmountInput, toLocalInput } from "@/lib/utils";

const RECURRENCE_LABEL: Record<Recurrence, string> = {
  none: "Sekali",
  daily: "Setiap hari",
  weekly: "Setiap minggu",
  monthly: "Setiap bulan",
};

const STATUS_LABEL: Record<Reminder["status"], string> = {
  pending: "Terjadwal",
  sending: "Mengirim",
  sent: "Terkirim",
  failed: "Gagal",
  cancelled: "Dibatalkan",
};

export default function RemindersPage() {
  const { user } = useSession();
  const [view, setView] = useState<"active" | "all">("active");
  const { data, isLoading, mutate } = useSWR<Reminder[]>(paths.reminders(view));

  const inOneHour = toLocalInput(new Date(Date.now() + 3600_000).toISOString(), user.timezone);
  const [form, setForm] = useState({ task: "", remind_at: inOneHour, recurrence: "none" as Recurrence, amount: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createReminder({
        task: form.task.trim(),
        remind_at: `${form.remind_at}:00`,
        recurrence: form.recurrence,
        amount: form.amount ? parseAmountInput(form.amount) || null : null,
      });
      setForm({ task: "", remind_at: inOneHour, recurrence: "none", amount: "" });
      await mutate();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function cancel(id: number) {
    setError(null);
    try {
      await api.cancelReminder(id);
      await mutate();
    } catch (err) {
      setError(`Gagal membatalkan: ${(err as Error).message}`);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pengingat</h1>
        <p className="text-sm text-muted-foreground">
          Notifikasi dikirim ke Telegram tepat waktu. Kamu juga bisa membuatnya lewat chat:{" "}
          <code className="rounded bg-muted px-1">Ingatkan bayar listrik tanggal 25 jam 9 pagi</code>
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              <BellRing className="h-4 w-4 text-muted-foreground" /> {view === "active" ? "Pengingat aktif" : "Semua pengingat"}
            </CardTitle>
            <Select className="h-9 w-40" value={view} onChange={(e) => setView(e.target.value as "active" | "all")} aria-label="Tampilan">
              <option value="active">Aktif</option>
              <option value="all">Semua</option>
            </Select>
          </CardHeader>
          <CardContent>
            {isLoading && !data ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : !data?.length ? (
              <EmptyState icon={<BellRing className="h-8 w-8" />} title="Belum ada pengingat" />
            ) : (
              <ul className="divide-y">
                {data.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {r.task}
                        {r.amount ? <span className="font-normal text-muted-foreground"> · {formatMoney(r.amount, user.currency)}</span> : null}
                      </p>
                      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {formatDate(r.remind_at, user.timezone)}
                        {r.recurrence !== "none" && (
                          <span className="inline-flex items-center gap-1">
                            <Repeat className="h-3 w-3" /> {RECURRENCE_LABEL[r.recurrence]}
                          </span>
                        )}
                        <span>#{r.id}</span>
                      </p>
                      {r.status === "failed" && r.last_error && <p className="mt-1 truncate text-xs text-destructive">{r.last_error}</p>}
                    </div>
                    <Badge className={cn(r.status === "failed" && "border-destructive text-destructive")}>{STATUS_LABEL[r.status]}</Badge>
                    {(r.status === "pending" || r.status === "failed") && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => cancel(r.id)}
                        aria-label={`Batalkan pengingat #${r.id}`}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BellPlus className="h-4 w-4 text-muted-foreground" /> Pengingat baru
            </CardTitle>
            <CardDescription>Zona waktu: {user.timezone}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={create} className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="r-task">Tugas</Label>
                <Input
                  id="r-task"
                  required
                  maxLength={255}
                  placeholder="Bayar listrik"
                  value={form.task}
                  onChange={(e) => setForm({ ...form, task: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="r-at">Waktu</Label>
                <Input
                  id="r-at"
                  type="datetime-local"
                  required
                  value={form.remind_at}
                  onChange={(e) => setForm({ ...form, remind_at: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="r-rec">Ulangi</Label>
                  <Select id="r-rec" value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value as Recurrence })}>
                    {(Object.keys(RECURRENCE_LABEL) as Recurrence[]).map((k) => (
                      <option key={k} value={k}>
                        {RECURRENCE_LABEL[k]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="r-amt">Nominal</Label>
                  <Input
                    id="r-amt"
                    placeholder="Opsional, mis. 350rb"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  />
                </div>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={saving}>
                {saving ? "Menyimpan…" : "Simpan pengingat"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
