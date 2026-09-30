"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useSession } from "@/components/session";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/misc";
import { api, paths } from "@/lib/api";
import type { Category, DebtDirection, Transaction, TransactionInput, TxType } from "@/lib/types";
import { DEBT_LABEL, PAYMENT_METHODS, TYPE_LABEL, parseAmountInput, toLocalInput } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Pass a transaction to edit it; omit to create a new one. */
  transaction?: Transaction | null;
}

function initialState(t: Transaction | null | undefined, tz: string) {
  return {
    type: (t?.type ?? "expense") as TxType,
    amount: t ? String(t.amount) : "",
    category_id: t?.category_id ? String(t.category_id) : "",
    description: t?.description ?? "",
    merchant: t?.merchant ?? "",
    payment_method: t?.payment_method ?? "Tunai",
    debt_direction: (t?.debt_direction ?? "borrow") as DebtDirection,
    counterparty: t?.counterparty ?? "",
    transaction_date: toLocalInput(t?.transaction_date ?? new Date().toISOString(), tz),
  };
}

export function TransactionFormDialog({ open, onClose, onSaved, transaction }: Props) {
  const { user } = useSession();
  const { data: categories } = useSWR<Category[]>(open ? paths.categories : null, { refreshInterval: 0 });
  const [form, setForm] = useState(() => initialState(transaction, user.timezone));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initialState(transaction, user.timezone));
      setError(null);
    }
  }, [open, transaction, user.timezone]);

  const options = useMemo(() => (categories ?? []).filter((c) => c.type === form.type), [categories, form.type]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseAmountInput(form.amount);
    if (!amount || amount <= 0) {
      setError("Jumlah tidak terbaca. Contoh: 50000, 50.000, 50rb, atau 1,5jt");
      return;
    }
    const payload: TransactionInput = {
      type: form.type,
      amount,
      category_id: form.category_id ? Number(form.category_id) : null,
      description: form.description.trim(),
      merchant: form.merchant.trim() || null,
      payment_method: form.payment_method,
      debt_direction: form.type === "debt" ? form.debt_direction : null,
      counterparty: form.counterparty.trim() || null,
      // Local wall-clock time; the API interprets it in the user's timezone.
      transaction_date: `${form.transaction_date}:00`,
    };
    setSaving(true);
    setError(null);
    try {
      if (transaction) await api.updateTransaction(transaction.id, payload);
      else await api.createTransaction(payload);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={transaction ? `Ubah transaksi #${transaction.id}` : "Tambah transaksi"}>
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tx-type">Tipe</Label>
            <Select
              id="tx-type"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as TxType, category_id: "" }))}
            >
              {(Object.keys(TYPE_LABEL) as TxType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tx-amount">Jumlah ({user.currency})</Label>
            <Input
              id="tx-amount"
              required
              placeholder="50rb atau 50.000"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
            />
          </div>
        </div>

        {form.type === "debt" && (
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="tx-dir">Jenis</Label>
              <Select id="tx-dir" value={form.debt_direction} onChange={(e) => set("debt_direction", e.target.value as DebtDirection)}>
                {Object.entries(DEBT_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tx-cp">Pihak lain</Label>
              <Input id="tx-cp" placeholder="Budi" value={form.counterparty} onChange={(e) => set("counterparty", e.target.value)} />
            </div>
          </div>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="tx-desc">Deskripsi</Label>
          <Input
            id="tx-desc"
            placeholder="Makan siang"
            maxLength={255}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tx-cat">Kategori</Label>
            <Select id="tx-cat" value={form.category_id} onChange={(e) => set("category_id", e.target.value)}>
              <option value="">— Tanpa kategori —</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tx-pm">Metode bayar</Label>
            <Select id="tx-pm" value={form.payment_method} onChange={(e) => set("payment_method", e.target.value)}>
              {[...new Set([form.payment_method, ...PAYMENT_METHODS])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tx-date">Tanggal & jam</Label>
            <Input
              id="tx-date"
              type="datetime-local"
              required
              value={form.transaction_date}
              onChange={(e) => set("transaction_date", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tx-merchant">Merchant</Label>
            <Input id="tx-merchant" placeholder="Opsional" value={form.merchant} onChange={(e) => set("merchant", e.target.value)} />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Menyimpan…" : "Simpan"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
