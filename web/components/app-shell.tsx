"use client";

import { BellRing, LayoutDashboard, LogOut, ReceiptText, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSession } from "./session";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/transactions", label: "Transaksi", icon: ReceiptText },
  { href: "/reminders", label: "Pengingat", icon: BellRing },
];

function isActive(pathname: string, href: string) {
  const p = pathname.replace(/\/+$/, "") || "/";
  return href === "/" ? p === "/" : p.startsWith(href);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useSession();
  // The Users page is only for owners (IDs in ALLOWED_TELEGRAM_IDS).
  const nav = user.is_owner ? [...NAV, { href: "/users", label: "Pengguna", icon: Users }] : NAV;

  async function logout() {
    await api.logout().catch(() => undefined);
    window.location.href = "/";
  }

  const name = user.first_name || (user.username ? `@${user.username}` : `ID ${user.telegram_id}`);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      {/* Sidebar (desktop) */}
      <aside className="hidden border-r bg-card md:flex md:flex-col">
        <div className="flex h-16 items-center gap-2 px-5 font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Wallet className="h-4 w-4" />
          </span>
          Catatku
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive(pathname, href) ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="border-t p-4">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">{user.timezone}</p>
          <button onClick={logout} className="mt-3 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <LogOut className="h-4 w-4" /> Keluar
          </button>
        </div>
      </aside>

      {/* Top bar (mobile) */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-card/95 px-4 backdrop-blur md:hidden">
        <div className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Wallet className="h-4 w-4" />
          </span>
          Catatku
        </div>
        <button onClick={logout} aria-label="Keluar" className="rounded-md p-2 text-muted-foreground hover:bg-accent">
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      <main className="min-w-0 px-4 pb-24 pt-6 md:px-8 md:pb-10">{children}</main>

      {/* Bottom tabs (mobile) */}
      <nav className={cn("fixed inset-x-0 bottom-0 z-20 grid border-t bg-card md:hidden", nav.length > 3 ? "grid-cols-4" : "grid-cols-3")}>
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex flex-col items-center gap-1 py-2 text-xs",
              isActive(pathname, href) ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className="h-5 w-5" />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
