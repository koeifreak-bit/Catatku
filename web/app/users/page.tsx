"use client";

import { Ban, Check, Crown, Info, ShieldAlert, Trash2, UserPlus, Users, X } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { useSession } from "@/components/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Badge, Dialog, EmptyState, Skeleton } from "@/components/ui/misc";
import { api, paths } from "@/lib/api";
import type { PeopleResponse, Person } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";

function displayName(p: { name: string | null; username: string | null; telegram_id: number }) {
  return p.name || (p.username ? `@${p.username}` : `ID ${p.telegram_id}`);
}

function Avatar({ label, tone = "muted" }: { label: string; tone?: "muted" | "owner" | "pending" }) {
  const letter = label.replace(/^@/, "").charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold",
        tone === "owner" && "bg-primary/15 text-primary",
        tone === "pending" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {letter}
    </span>
  );
}

export default function UsersPage() {
  const { user } = useSession();
  const { data, error, isLoading, mutate } = useSWR<PeopleResponse>(user.is_owner ? paths.people : null);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "add" | null>(null);
  const [removing, setRemoving] = useState<Person | null>(null);

  if (!user.is_owner) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState icon={<ShieldAlert className="h-8 w-8" />} title="Hanya untuk pemilik bot">
          Halaman ini dipakai pemilik bot untuk mengatur siapa saja yang boleh memakai Catatku.
        </EmptyState>
      </div>
    );
  }

  async function run(id: number | "add", fn: () => Promise<unknown>, done?: string) {
    setBusy(id);
    setNotice(null);
    try {
      await fn();
      await mutate();
      if (done) setNotice(done);
    } catch (err) {
      setNotice(`Gagal: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const id = Number(newId.trim());
    if (!Number.isSafeInteger(id) || id <= 0) {
      setFormError("ID Telegram berupa angka saja, contoh 123456789.");
      return;
    }
    setFormError(null);
    await run(
      "add",
      async () => {
        const res = await api.addPerson(id, newName.trim() || undefined);
        setNewId("");
        setNewName("");
        return res;
      },
      "Ditambahkan. Dia bisa langsung memakai bot dengan mengirim /start.",
    );
  }

  const pending = data?.people.filter((p) => p.status === "pending") ?? [];
  const approved = data?.people.filter((p) => p.status === "approved") ?? [];
  const blocked = data?.people.filter((p) => p.status === "blocked") ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pengguna</h1>
        <p className="text-sm text-muted-foreground">
          Atur siapa saja yang boleh memakai bot. Setiap orang punya catatan, budget dan dashboard sendiri yang terpisah.
        </p>
      </div>

      {notice && (
        <p role="status" className="flex items-start justify-between gap-3 rounded-md bg-muted px-4 py-3 text-sm">
          {notice}
          <button onClick={() => setNotice(null)} aria-label="Tutup" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </p>
      )}

      {error && <p className="text-sm text-destructive">Tidak bisa memuat daftar: {error.message}</p>}

      {pending.length > 0 && (
        <Card className="border-amber-500/50">
          <CardHeader>
            <CardTitle>Menunggu persetujuan ({pending.length})</CardTitle>
            <CardDescription>Orang-orang ini sudah mengirim pesan ke bot dan meminta akses.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {pending.map((p) => (
                <li key={p.telegram_id} className="flex flex-wrap items-center gap-3 py-3">
                  <Avatar label={displayName(p)} tone="pending" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{displayName(p)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.username && p.name ? `@${p.username} · ` : ""}ID {p.telegram_id}
                      {p.requested_at ? ` · minta ${formatDate(p.requested_at, user.timezone)}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy === p.telegram_id}
                      onClick={() =>
                        run(p.telegram_id, async () => {
                          const res = await api.setPersonStatus(p.telegram_id, "approved");
                          setTimeout(() =>
                            setNotice(
                              res.notified
                                ? `${displayName(p)} diizinkan dan sudah diberi tahu lewat Telegram.`
                                : `${displayName(p)} diizinkan. Pesan Telegram tidak terkirim, jadi beri tahu dia untuk mengirim /start.`,
                            ),
                          );
                        })
                      }
                    >
                      <Check /> Izinkan
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === p.telegram_id}
                      onClick={() => run(p.telegram_id, () => api.setPersonStatus(p.telegram_id, "blocked"), `${displayName(p)} ditolak.`)}
                    >
                      <Ban /> Tolak
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-muted-foreground" /> Tambah orang
          </CardTitle>
          <CardDescription>Masukkan ID Telegram-nya. Dia bisa langsung memakai bot setelah ditambahkan.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="person-id">ID Telegram</Label>
              <Input
                id="person-id"
                inputMode="numeric"
                placeholder="123456789"
                value={newId}
                onChange={(e) => setNewId(e.target.value.replace(/[^\d]/g, ""))}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="person-name">Nama (opsional)</Label>
              <Input id="person-name" placeholder="Budi" maxLength={64} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy === "add"}>
              <UserPlus /> {busy === "add" ? "Menambahkan…" : "Tambah"}
            </Button>
          </form>
          {formError && <p className="mt-2 text-sm text-destructive">{formError}</p>}
          <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Tidak tahu ID-nya? Minta dia mengirim pesan apa saja ke bot. Bot membalas dengan ID-nya, dan permintaannya muncul di atas dan di Telegram-mu
              dengan tombol <b>Izinkan</b>.
            </span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" /> Yang boleh memakai bot
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && !data ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : (
            <ul className="divide-y">
              {data?.owners.map((o) => (
                <li key={`o${o.telegram_id}`} className="flex items-center gap-3 py-3">
                  <Avatar label={displayName(o)} tone="owner" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {displayName(o)}
                      {o.is_me && <span className="font-normal text-muted-foreground"> (kamu)</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">ID {o.telegram_id} · diatur di Cloudflare (ALLOWED_TELEGRAM_IDS)</p>
                  </div>
                  <Badge className="border-primary/30 text-primary">
                    <Crown className="h-3 w-3" /> Pemilik
                  </Badge>
                </li>
              ))}
              {approved.map((p) => (
                <li key={p.telegram_id} className="flex items-center gap-3 py-3">
                  <Avatar label={displayName(p)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{displayName(p)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.username && p.name ? `@${p.username} · ` : ""}ID {p.telegram_id}
                      {p.started_at ? ` · aktif sejak ${formatDate(p.started_at, user.timezone, false)}` : " · belum mulai memakai bot"}
                    </p>
                  </div>
                  <Badge className={p.started_at ? "" : "text-muted-foreground"}>{p.started_at ? "Aktif" : "Belum mulai"}</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setRemoving(p)}
                    aria-label={`Hapus ${displayName(p)}`}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
              {data && approved.length === 0 && (
                <li className="py-4 text-sm text-muted-foreground">Belum ada orang lain. Tambahkan lewat form di atas.</li>
              )}
            </ul>
          )}
        </CardContent>
      </Card>

      {blocked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-muted-foreground" /> Ditolak ({blocked.length})
            </CardTitle>
            <CardDescription>Bot menolak pesan mereka dan tidak meneruskan permintaan baru dari mereka.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {blocked.map((p) => (
                <li key={p.telegram_id} className="flex flex-wrap items-center gap-3 py-3">
                  <Avatar label={displayName(p)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{displayName(p)}</p>
                    <p className="truncate text-xs text-muted-foreground">ID {p.telegram_id}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === p.telegram_id}
                    onClick={() => run(p.telegram_id, () => api.setPersonStatus(p.telegram_id, "approved"), `${displayName(p)} diizinkan.`)}
                  >
                    <Check /> Izinkan
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === p.telegram_id}
                    onClick={() => run(p.telegram_id, () => api.removePerson(p.telegram_id), `${displayName(p)} dihapus dari daftar.`)}
                  >
                    Hapus dari daftar
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Hapus ${removing ? displayName(removing) : ""}?`}
        description="Dia tidak bisa memakai bot dan dashboard lagi, dan pengingatnya berhenti terkirim."
      >
        <p className="text-sm text-muted-foreground">
          Catatan keuangannya tidak dihapus. Kalau kamu mengizinkannya lagi nanti, datanya masih ada.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(null)}>
            Batal
          </Button>
          <Button
            variant="destructive"
            disabled={!!removing && busy === removing.telegram_id}
            onClick={async () => {
              const p = removing;
              if (!p) return;
              await run(p.telegram_id, () => api.removePerson(p.telegram_id), `${displayName(p)} dihapus.`);
              setRemoving(null);
            }}
          >
            <Trash2 /> Hapus
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
