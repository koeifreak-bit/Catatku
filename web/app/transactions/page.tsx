"use client";

import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Pencil,
  Plus,
  ReceiptText,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { Amount } from "@/components/amount";
import { useSession } from "@/components/session";
import { TransactionFormDialog } from "@/components/transaction-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Badge, Dialog, EmptyState, Skeleton } from "@/components/ui/misc";
import { api, paths } from "@/lib/api";
import { exportCsv, exportXlsx } from "@/lib/export";
import type { Category, Paginated, Transaction, TransactionFilters, TxType } from "@/lib/types";
import { DEBT_LABEL, TYPE_LABEL, cn, formatDate, formatMoney } from "@/lib/utils";

const EMPTY_FILTERS: TransactionFilters = {
  search: "",
  type: "",
  category_id: "",
  date_from: "",
  date_to: "",
  sort: "transaction_date",
  dir: "desc",
  page: 1,
  page_size: 20,
};

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export default function TransactionsPage() {
  const { user } = useSession();
  const cur = user.currency;
  const [filters, setFilters] = useState<TransactionFilters>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Transaction | null>(null);
  const [viewing, setViewing] = useState<Transaction | null>(null);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFilters((f) => (f.search === search ? f : { ...f, search, page: 1 }));
  }, [search]);

  const { data, isLoading, mutate } = useSWR<Paginated<Transaction>>(paths.transactions(filters), { keepPreviousData: true });
  const { data: categories } = useSWR<Category[]>(paths.categories, { refreshInterval: 0 });

  const [actionError, setActionError] = useState<string | null>(null);

  // If rows were deleted elsewhere the server returns the last page that exists; follow it.
  useEffect(() => {
    // (Only when we're past the last page: while a new page loads, `data` still holds the previous one.)
    if (data && (filters.page ?? 1) > data.pages) setFilters((f) => ({ ...f, page: data.pages }));
  }, [data, filters.page]);

  const update = (patch: Partial<TransactionFilters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));
  const isFiltered =
    !!(filters.search || filters.type || filters.category_id || filters.date_from || filters.date_to);

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteTransaction(deleting.id);
      await mutate();
      setDeleting(null);
    } catch (err) {
      setActionError(`Gagal menghapus: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function doExport(kind: "csv" | "xlsx") {
    setExporting(kind);
    setActionError(null);
    try {
      const { items, timezone, truncated } = await api.exportTransactions(filters);
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === "csv") exportCsv(items, timezone, `catatku-transaksi-${stamp}.csv`);
      else exportXlsx(items, timezone, `catatku-transaksi-${stamp}.xlsx`);
      if (truncated) setActionError("Hanya 10.000 transaksi pertama yang diekspor. Persempit filter tanggal untuk sisanya.");
    } catch (err) {
      setActionError(`Gagal mengekspor: ${(err as Error).message}`);
    } finally {
      setExporting(null);
    }
  }

  const toggleSort = (sort: TransactionFilters["sort"]) =>
    update({ sort, dir: filters.sort === sort && filters.dir === "desc" ? "asc" : "desc" });

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transaksi</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${data.total.toLocaleString("id-ID")} transaksi${isFiltered ? " sesuai filter" : ""}` : "Memuat…"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => doExport("csv")} disabled={!!exporting}>
            <FileText /> {exporting === "csv" ? "Mengekspor…" : "CSV"}
          </Button>
          <Button variant="outline" onClick={() => doExport("xlsx")} disabled={!!exporting}>
            <FileSpreadsheet /> {exporting === "xlsx" ? "Mengekspor…" : "Excel"}
          </Button>
          <Button onClick={() => setAdding(true)}>
            <Plus /> Tambah
          </Button>
        </div>
      </div>

      {actionError && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {actionError}
        </p>
      )}

      {/* Filters — one row above the data */}
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[1fr_160px_200px_150px_150px_auto]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Cari deskripsi, merchant, kategori…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Cari transaksi"
          />
        </div>
        <Select value={filters.type} onChange={(e) => update({ type: e.target.value as TxType | "" })} aria-label="Filter tipe">
          <option value="">Semua tipe</option>
          {(Object.keys(TYPE_LABEL) as TxType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <Select value={filters.category_id} onChange={(e) => update({ category_id: e.target.value })} aria-label="Filter kategori">
          <option value="">Semua kategori</option>
          <option value="none">Tanpa kategori</option>
          {(categories ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon} {c.name}
            </option>
          ))}
        </Select>
        <Input type="date" value={filters.date_from} onChange={(e) => update({ date_from: e.target.value })} aria-label="Dari tanggal" />
        <Input type="date" value={filters.date_to} onChange={(e) => update({ date_to: e.target.value })} aria-label="Sampai tanggal" />
        <Button
          variant="ghost"
          disabled={!isFiltered}
          onClick={() => {
            setSearchInput("");
            setFilters(EMPTY_FILTERS);
          }}
        >
          <RotateCcw /> Reset
        </Button>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">
                  <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("transaction_date")}>
                    Tanggal <ArrowDownUp className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-4 py-3 font-medium">Deskripsi</th>
                <th className="px-4 py-3 font-medium">Kategori</th>
                <th className="px-4 py-3 font-medium">Metode</th>
                <th className="px-4 py-3 font-medium">Tipe</th>
                <th className="px-4 py-3 text-right font-medium">
                  <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort("amount")}>
                    Jumlah <ArrowDownUp className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  <span className="sr-only">Aksi</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && !data
                ? Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={7} className="px-4 py-3">
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  ))
                : data?.items.map((t) => (
                    <tr key={t.id} className="hover:bg-muted/40">
                      <td className="tabular whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {formatDate(t.transaction_date, user.timezone)}
                      </td>
                      <td className="max-w-[280px] px-4 py-3">
                        <p className="truncate font-medium">{t.description || t.merchant || "—"}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[t.merchant && t.merchant !== t.description ? t.merchant : null, t.counterparty, `#${t.id}`]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {t.category ? (
                          <Badge className="border-transparent bg-muted">
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ background: t.category.color }}
                              aria-hidden
                            />
                            {t.category.icon} {t.category.name}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{t.payment_method}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span className="text-muted-foreground">
                          {TYPE_LABEL[t.type]}
                          {t.debt_direction && <span className="block text-xs">{DEBT_LABEL[t.debt_direction]}</span>}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Amount t={t} currency={cur} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="inline-flex gap-1">
                          {t.receipt_data && (
                            <Button variant="ghost" size="icon" onClick={() => setViewing(t)} aria-label={`Lihat struk #${t.id}`}>
                              <ReceiptText />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" onClick={() => setEditing(t)} aria-label={`Ubah #${t.id}`}>
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleting(t)}
                            aria-label={`Hapus #${t.id}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>

        {data && data.items.length === 0 && (
          <EmptyState icon={<ReceiptText className="h-8 w-8" />} title={isFiltered ? "Tidak ada transaksi yang cocok" : "Belum ada transaksi"}>
            {isFiltered ? "Coba ubah atau reset filter." : "Transaksi dari bot Telegram akan muncul di sini."}
          </EmptyState>
        )}

        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              Baris per halaman
              <Select
                className="h-8 w-20"
                value={filters.page_size}
                onChange={(e) => update({ page_size: Number(e.target.value) })}
                aria-label="Baris per halaman"
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">
                Halaman {data.page} dari {data.pages}
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={data.page <= 1}
                onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) - 1 }))}
                aria-label="Halaman sebelumnya"
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                disabled={data.page >= data.pages}
                onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) + 1 }))}
                aria-label="Halaman berikutnya"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </Card>

      <TransactionFormDialog open={adding} onClose={() => setAdding(false)} onSaved={() => mutate()} />
      <TransactionFormDialog open={!!editing} transaction={editing} onClose={() => setEditing(null)} onSaved={() => mutate()} />

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Hapus transaksi?"
        description={deleting ? `${deleting.description || "Transaksi"} — ${formatMoney(deleting.amount, cur)} (#${deleting.id})` : ""}
      >
        <p className="text-sm text-muted-foreground">Tindakan ini tidak bisa dibatalkan. Saldo akan dihitung ulang.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            Batal
          </Button>
          <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
            <Trash2 /> {busy ? "Menghapus…" : "Hapus"}
          </Button>
        </div>
      </Dialog>

      <Dialog open={!!viewing} onClose={() => setViewing(null)} title="Detail struk" description={viewing?.receipt_data?.merchant_name}>
        {viewing?.receipt_data && <ReceiptDetail t={viewing} currency={cur} />}
      </Dialog>
    </div>
  );
}

function ReceiptDetail({ t, currency }: { t: Transaction; currency: string }) {
  const r = t.receipt_data!;
  const row = (label: string, value: number | null, negative = false) =>
    value ? (
      <div className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span className="tabular">
          {negative ? "−" : ""}
          {formatMoney(value, currency)}
        </span>
      </div>
    ) : null;
  return (
    <div className="space-y-4 text-sm">
      <table className="w-full">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="pb-2 font-medium">Item</th>
            <th className="pb-2 text-right font-medium">Qty</th>
            <th className="pb-2 text-right font-medium">Harga</th>
            <th className="pb-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {r.items.map((i, idx) => (
            <tr key={idx}>
              <td className="py-1.5 pr-2">{i.name}</td>
              <td className="tabular py-1.5 text-right">{i.quantity}</td>
              <td className="tabular py-1.5 text-right">{formatMoney(i.unit_price, currency)}</td>
              <td className="tabular py-1.5 text-right">{formatMoney(i.total_price, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={cn("space-y-1 border-t pt-3")}>
        {row("Subtotal", r.subtotal)}
        {row("Pajak", r.tax)}
        {row("Service", r.service_charge)}
        {row("Diskon", r.discount, true)}
        <div className="flex justify-between font-semibold">
          <span>Total</span>
          <span className="tabular">{formatMoney(t.amount, currency)}</span>
        </div>
      </div>
    </div>
  );
}
