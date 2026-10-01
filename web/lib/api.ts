import type {
  Category,
  DashboardSummary,
  InsightResponse,
  Paginated,
  Recurrence,
  Reminder,
  Transaction,
  TransactionFilters,
  TransactionInput,
  User,
} from "./types";

/** API client. The dashboard and the Worker API share one origin, so the session cookie rides along. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && ("message" in data ? String(data.message) : "error" in data ? String(data.error) : "")) ||
      `HTTP ${res.status}`;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

/** SWR fetcher: keys are API paths. */
export const fetcher = <T,>(path: string) => request<T>(path);

export function toQuery(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export const paths = {
  me: "/api/me",
  summary: (month: string) => `/api/dashboard/summary${toQuery({ month })}`,
  insights: (month: string) => `/api/dashboard/insights${toQuery({ month })}`,
  transactions: (f: TransactionFilters) => `/api/transactions${toQuery({ ...f })}`,
  categories: "/api/categories",
  reminders: (status: "active" | "all" = "active") => `/api/reminders${toQuery({ status: status === "all" ? "all" : undefined })}`,
  people: "/api/admin/users",
};

export const api = {
  me: () => request<User>(paths.me),
  updateMe: (patch: Partial<Pick<User, "monthly_budget" | "initial_balance" | "timezone" | "currency">>) =>
    request<User>(paths.me, { method: "PATCH", body: JSON.stringify(patch) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  summary: (month: string) => request<DashboardSummary>(paths.summary(month)),
  insights: (month: string, refresh = false) =>
    request<InsightResponse>(`/api/dashboard/insights${toQuery({ month, refresh: refresh ? 1 : undefined })}`),

  transactions: (f: TransactionFilters) => request<Paginated<Transaction>>(paths.transactions(f)),
  exportTransactions: (f: TransactionFilters) =>
    request<{ items: Transaction[]; currency: string; timezone: string; truncated?: boolean }>(
      `/api/transactions/export${toQuery({ ...f, page: undefined, page_size: undefined })}`,
    ),
  createTransaction: (input: TransactionInput) =>
    request<Transaction>("/api/transactions", { method: "POST", body: JSON.stringify(input) }),
  updateTransaction: (id: number, input: Partial<TransactionInput>) =>
    request<Transaction>(`/api/transactions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteTransaction: (id: number) => request<void>(`/api/transactions/${id}`, { method: "DELETE" }),

  categories: () => request<Category[]>(paths.categories),
  createCategory: (input: Pick<Category, "name" | "type" | "icon" | "color">) =>
    request<Category>("/api/categories", { method: "POST", body: JSON.stringify(input) }),
  deleteCategory: (id: number) => request<void>(`/api/categories/${id}`, { method: "DELETE" }),

  reminders: (status: "active" | "all" = "active") => request<Reminder[]>(paths.reminders(status)),
  createReminder: (input: { task: string; remind_at: string; recurrence: Recurrence; amount: number | null }) =>
    request<Reminder>("/api/reminders", { method: "POST", body: JSON.stringify(input) }),
  cancelReminder: (id: number) => request<void>(`/api/reminders/${id}`, { method: "DELETE" }),

  addPerson: (telegram_id: number, name?: string) =>
    request<{ ok: true; notified: boolean }>("/api/admin/users", { method: "POST", body: JSON.stringify({ telegram_id, name }) }),
  setPersonStatus: (telegramId: number, status: "approved" | "blocked") =>
    request<{ ok: true; notified?: boolean }>(`/api/admin/users/${telegramId}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  removePerson: (telegramId: number) => request<void>(`/api/admin/users/${telegramId}`, { method: "DELETE" }),
};
