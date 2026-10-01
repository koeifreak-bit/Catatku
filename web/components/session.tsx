"use client";

import { Loader2, LockKeyhole, Send } from "lucide-react";
import { createContext, useContext } from "react";
import useSWR, { SWRConfig, mutate as globalMutate } from "swr";
import { ApiError, fetcher, paths } from "@/lib/api";
import type { User } from "@/lib/types";

interface Session {
  user: User;
  refreshUser: () => Promise<unknown>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside <SessionProvider>");
  return s;
}

function LoginRequired({ revoked = false }: { revoked?: boolean }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
          <LockKeyhole className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold">{revoked ? "Akses dicabut" : "Masuk ke Catatku"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {revoked
            ? "Pemilik bot sudah menghapus aksesmu. Hubungi pemiliknya kalau ini keliru."
            : "Dashboard ini hanya bisa dibuka lewat link masuk dari bot Catatku di Telegram."}
        </p>
        <div className={revoked ? "hidden" : "mt-6 rounded-md bg-muted p-4 text-left text-sm"}>
          <p className="flex items-center gap-2 font-medium">
            <Send className="h-4 w-4" /> Cara masuk
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Buka bot Catatku di Telegram</li>
            <li>
              Kirim <code className="rounded bg-card px-1">/dashboard</code>
            </li>
            <li>Ketuk tombol “Buka Dashboard”</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

function SessionGate({ children }: { children: React.ReactNode }) {
  const { data, error, mutate } = useSWR<User>(paths.me, fetcher, { refreshInterval: 0, shouldRetryOnError: false });

  if (error instanceof ApiError && error.status === 401) return <LoginRequired />;
  if (error instanceof ApiError && error.status === 403) return <LoginRequired revoked />;
  if (error) {
    return (
      <div className="grid min-h-screen place-items-center px-4 text-center">
        <div>
          <p className="font-medium">Tidak bisa terhubung ke server.</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid min-h-screen place-items-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Memuat" />
      </div>
    );
  }
  return <SessionContext.Provider value={{ user: data, refreshUser: () => mutate() }}>{children}</SessionContext.Provider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        // "Real-time" dashboard: poll while the tab is visible, and refresh on focus/reconnect.
        refreshInterval: 15_000,
        revalidateOnFocus: true,
        revalidateOnReconnect: true,
        // Session expired (or access removed) while the page was open: re-check /api/me so the
        // gate swaps in the login screen instead of leaving broken cards everywhere.
        onError: (err, key) => {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403) && key !== paths.me) {
            void globalMutate(paths.me);
          }
        },
      }}
    >
      <SessionGate>{children}</SessionGate>
    </SWRConfig>
  );
}
