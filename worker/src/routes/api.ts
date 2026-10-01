import { type Context, Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { type AppContext, ownerTelegramIds } from "../env";
import { SESSION_COOKIE, verifySessionJwt } from "../lib/auth";
import { type CategoryRow, type TransactionRow, TX_SELECT, getDb, must } from "../lib/db";
import { dayBounds, isZoneName, parseAiDateTime, parsePeriod, periodKey, safeTz } from "../lib/dates";
import { Api } from "grammy";
import {
  APPROVED_MESSAGE,
  accessFor,
  approveUser,
  blockUser,
  canUse,
  listAllowedUsers,
  removeAllowedUser,
} from "../services/access";
import { AIError, type FinancialInsight, generateInsight } from "../services/ai";
import {
  cancelReminder,
  createReminder,
  dashboardSummary,
  getUser,
  listCategories,
  listReminders,
  monthSnapshot,
  updateUser,
} from "../services/finance";

export const api = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// Auth guard: every /api route requires a valid session cookie.
// ---------------------------------------------------------------------------

api.use("*", async (c, next) => {
  const userId = await verifySessionJwt(c.env, getCookie(c, SESSION_COOKIE));
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  // Cheap CSRF defence on top of SameSite=Lax: state-changing requests must be JSON (not a form post).
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.method !== "DELETE") {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
  }
  // The session is only as good as the person's access: if an owner removed or blocked them, log them out.
  const db = getDb(c.env);
  const user = await getUser(db, userId);
  const access = user ? await accessFor(c.env, db, Number(user.telegram_id)) : "unknown";
  if (!user) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ error: "unauthorized" }, 401);
  }
  // Keep the cookie on 403 so the dashboard can show "access removed" rather than the generic login screen.
  // It's useless anyway: every request re-checks access.
  if (!canUse(access)) return c.json({ error: "access_revoked" }, 403);
  c.set("userId", userId);
  c.set("user", user);
  c.set("isOwner", access === "owner");
  await next();
});

api.onError((err, c) => {
  console.error("API error", { path: c.req.path, error: String(err) });
  return c.json({ error: "internal_error", message: err.message }, 500);
});

async function body<S extends z.ZodType>(c: Context<AppContext>, schema: S): Promise<z.infer<S> | Response> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return c.json({ error: "validation_error", issues: parsed.error.issues }, 422);
  return parsed.data;
}

async function currentUser(c: Context<AppContext>) {
  return c.get("user");
}

function idParam(c: Context<AppContext>): number | null {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Me / settings
// ---------------------------------------------------------------------------

api.get("/me", (c) => {
  const { telegram_chat_id: _chat, ...user } = c.get("user");
  return c.json({ ...user, is_owner: c.get("isOwner"), open_mode: ownerTelegramIds(c.env).size === 0 });
});

const SettingsPatch = z
  .object({
    monthly_budget: z.number().min(0).max(1e13),
    initial_balance: z.number().min(-1e13).max(1e13),
    timezone: z.string().refine(isZoneName, "use a zone name like Asia/Jakarta"),
    currency: z.string().min(3).max(8),
  })
  .partial();

api.patch("/me", async (c) => {
  const patch = await body(c, SettingsPatch);
  if (patch instanceof Response) return patch;
  return c.json(await updateUser(getDb(c.env), c.get("userId"), patch));
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

api.get("/dashboard/summary", async (c) => {
  const db = getDb(c.env);
  const user = await currentUser(c);
  const summary = await dashboardSummary(db, user, c.req.query("month"));
  const recent = must(
    await db
      .from("transactions")
      .select(TX_SELECT)
      .eq("user_id", user.id)
      .order("transaction_date", { ascending: false })
      .limit(6),
    "recent transactions",
  ) as TransactionRow[];
  return c.json({ ...summary, recent_transactions: recent });
});

api.get("/dashboard/insights", async (c) => {
  const db = getDb(c.env);
  const user = await currentUser(c);
  const { year, month } = parsePeriod(c.req.query("month"), safeTz(user.timezone));
  const period = periodKey(year, month);
  const refresh = c.req.query("refresh") === "1";

  // The cached summary is reused only while the month's transactions are unchanged (same count and total),
  // so adding, editing or deleting a transaction triggers a fresh analysis on the next dashboard load.
  const summary = await dashboardSummary(db, user, period);
  const fingerprint = `${summary.transaction_count}:${summary.monthly_income}:${summary.monthly_expense}`;
  if (!refresh) {
    const cached = must(
      await db.from("ai_insights").select("content,updated_at").eq("user_id", user.id).eq("period", period).maybeSingle(),
      "cached insight",
    ) as { content: FinancialInsight & { _fingerprint?: string }; updated_at: string } | null;
    if (cached && cached.content._fingerprint === fingerprint) {
      const { _fingerprint: _f, ...insight } = cached.content;
      return c.json({ period, cached: true, generated_at: cached.updated_at, insight });
    }
  }

  const snapshot = await monthSnapshot(db, user, period);
  if (snapshot.transaction_count === 0) {
    const empty: FinancialInsight = {
      health_score: 0,
      status: "fair",
      headline: "Belum ada data untuk bulan ini.",
      summary: "Catat transaksi lewat bot Telegram agar AI bisa menganalisis kebiasaan belanjamu.",
      highlights: [],
      recommendations: ["Kirim pesan seperti “Beli makan siang 50rb” ke bot.", "Atur budget bulanan dengan /budget 3jt."],
    };
    return c.json({ period, cached: false, generated_at: new Date().toISOString(), insight: empty, empty: true });
  }

  let insight: FinancialInsight;
  try {
    insight = await generateInsight(c.env, snapshot);
  } catch (err) {
    if (err instanceof AIError) return c.json({ error: "ai_unavailable", message: err.message }, 503);
    throw err;
  }
  const now = new Date().toISOString();
  must(
    await db
      .from("ai_insights")
      .upsert(
        { user_id: user.id, period, content: { ...insight, _fingerprint: fingerprint }, updated_at: now },
        { onConflict: "user_id,period" },
      ),
    "store insight",
  );
  return c.json({ period, cached: false, generated_at: now, insight });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const TX_TYPES = ["expense", "income", "transfer", "debt"] as const;
const SORTABLE = new Set(["transaction_date", "amount", "created_at"]);

/** Apply the shared list/export filters to a transactions query. */
async function applyFilters(c: Context<AppContext>, tz: string, select: string = TX_SELECT) {
  const db = getDb(c.env);
  const userId = c.get("userId");
  const q = c.req.query();
  let query = db.from("transactions").select(select, { count: "exact" }).eq("user_id", userId);

  if (q.type && (TX_TYPES as readonly string[]).includes(q.type)) query = query.eq("type", q.type);
  if (q.category_id === "none") query = query.is("category_id", null);
  else if (q.category_id && Number(q.category_id) > 0) query = query.eq("category_id", Number(q.category_id));
  if (q.date_from) {
    const b = dayBounds(q.date_from, tz);
    if (b) query = query.gte("transaction_date", b[0].toISOString());
  }
  if (q.date_to) {
    const b = dayBounds(q.date_to, tz);
    if (b) query = query.lt("transaction_date", b[1].toISOString());
  }
  if (q.min_amount && Number(q.min_amount) > 0) query = query.gte("amount", Number(q.min_amount));
  if (q.max_amount && Number(q.max_amount) > 0) query = query.lte("amount", Number(q.max_amount));

  const search = (q.search ?? "").replace(/[%,()*\\:"'.]/g, " ").trim().slice(0, 64);
  if (search) {
    const like = `%${search}%`;
    const cats = must(
      await db
        .from("categories")
        .select("id")
        .or(`user_id.is.null,user_id.eq.${userId}`)
        .ilike("name", like),
      "search categories",
    ) as { id: number }[];
    const clauses = [
      `description.ilike.${like}`,
      `merchant.ilike.${like}`,
      `counterparty.ilike.${like}`,
      `payment_method.ilike.${like}`,
    ];
    if (cats.length) clauses.push(`category_id.in.(${cats.map((x) => x.id).join(",")})`);
    query = query.or(clauses.join(","));
  }

  const sort = SORTABLE.has(q.sort ?? "") ? q.sort! : "transaction_date";
  query = query.order(sort, { ascending: q.dir === "asc" }).order("id", { ascending: q.dir === "asc" });
  return { query };
}

api.get("/transactions", async (c) => {
  const user = await currentUser(c);
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("page_size")) || 20));
  const tz = safeTz(user.timezone);
  let { query } = await applyFilters(c, tz);
  let res = await query.range((page - 1) * pageSize, page * pageSize - 1);
  // PostgREST answers 416 (PGRST103) when the page is past the end, e.g. after rows were deleted elsewhere.
  // Fall back to the last page that exists instead of failing.
  if (res.error?.code === "PGRST103") {
    ({ query } = await applyFilters(c, tz));
    const head = await query.range(0, 0);
    const total = head.count ?? 0;
    const last = Math.max(1, Math.ceil(total / pageSize));
    ({ query } = await applyFilters(c, tz));
    res = await query.range((last - 1) * pageSize, last * pageSize - 1);
    const items = must(res, "list transactions") as unknown as TransactionRow[];
    return c.json({ items, total, page: last, page_size: pageSize, pages: last });
  }
  const items = must(res, "list transactions") as unknown as TransactionRow[];
  const total = res.count ?? items.length;
  return c.json({ items, total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
});

/**
 * All rows matching the filters (max 10k). Supabase caps each response at 1,000 rows, so fetch in pages.
 * The dashboard builds CSV/XLSX in the browser to stay within Worker CPU limits.
 */
const EXPORT_PAGE = 1_000;
const EXPORT_MAX = 10_000;
// Only the columns the CSV/XLSX needs (no receipt JSON), to keep the response small and cheap to serialise.
const EXPORT_SELECT =
  "id,type,amount,category_id,description,merchant,payment_method,debt_direction,counterparty,transaction_date,source,category:categories(id,name,icon,color,type)";

api.get("/transactions/export", async (c) => {
  const user = await currentUser(c);
  const tz = safeTz(user.timezone);
  const items: TransactionRow[] = [];
  for (let from = 0; from < EXPORT_MAX; from += EXPORT_PAGE) {
    const { query } = await applyFilters(c, tz, EXPORT_SELECT);
    const page = must(await query.range(from, from + EXPORT_PAGE - 1), "export transactions") as unknown as TransactionRow[];
    items.push(...page);
    if (page.length < EXPORT_PAGE) break;
  }
  return c.json({ items, currency: user.currency, timezone: user.timezone, truncated: items.length >= EXPORT_MAX });
});

// No .default() here: zod 4 keeps defaults inside .partial(), which would make PATCH overwrite fields the
// client didn't send. Defaults are applied in the POST handler instead.
const TransactionInput = z.object({
  type: z.enum(TX_TYPES),
  amount: z.number().positive().max(1e13),
  category_id: z.number().int().positive().nullable().optional(),
  description: z.string().max(255).optional(),
  merchant: z.string().max(128).nullable().optional(),
  payment_method: z.string().max(64).optional(),
  debt_direction: z.enum(["borrow", "repay", "lend", "collect"]).nullable().optional(),
  counterparty: z.string().max(128).nullable().optional(),
  transaction_date: z.string().min(10),
});

async function assertCategoryAccessible(c: Context<AppContext>, categoryId: number | null | undefined) {
  if (!categoryId) return true;
  const { data } = await getDb(c.env)
    .from("categories")
    .select("id,user_id")
    .eq("id", categoryId)
    .maybeSingle();
  return !!data && (data.user_id === null || data.user_id === c.get("userId"));
}

api.post("/transactions", async (c) => {
  const input = await body(c, TransactionInput);
  if (input instanceof Response) return input;
  if (input.type === "debt" && !input.debt_direction) return c.json({ error: "debt_direction is required for debt" }, 422);
  if (!(await assertCategoryAccessible(c, input.category_id))) return c.json({ error: "invalid category" }, 422);
  const user = await currentUser(c);
  const row = must(
    await getDb(c.env)
      .from("transactions")
      .insert({
        ...input,
        description: input.description ?? "",
        payment_method: input.payment_method || "Tunai",
        user_id: user.id,
        category_id: input.category_id ?? null,
        debt_direction: input.type === "debt" ? input.debt_direction : null,
        transaction_date: parseAiDateTime(input.transaction_date, safeTz(user.timezone)).toISOString(),
        source: "dashboard",
      })
      .select(TX_SELECT)
      .single(),
    "create transaction",
  );
  return c.json(row, 201);
});

api.get("/transactions/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const row = must(
    await getDb(c.env).from("transactions").select(TX_SELECT).eq("id", id).eq("user_id", c.get("userId")).maybeSingle(),
    "get transaction",
  );
  return row ? c.json(row) : c.json({ error: "not_found" }, 404);
});

api.patch("/transactions/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const input = await body(c, TransactionInput.partial());
  if (input instanceof Response) return input;
  if (!(await assertCategoryAccessible(c, input.category_id))) return c.json({ error: "invalid category" }, 422);
  const user = await currentUser(c);
  const patch: Record<string, unknown> = { ...input };
  if (input.transaction_date) {
    patch.transaction_date = parseAiDateTime(input.transaction_date, safeTz(user.timezone)).toISOString();
  }
  if (input.type && input.type !== "debt") patch.debt_direction = null;
  const { data, error } = await getDb(c.env)
    .from("transactions")
    .update(patch)
    .eq("id", id)
    .eq("user_id", user.id)
    .select(TX_SELECT)
    .maybeSingle();
  if (error) return c.json({ error: "update_failed", message: error.message }, 422);
  return data ? c.json(data) : c.json({ error: "not_found" }, 404);
});

api.delete("/transactions/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const rows = must(
    await getDb(c.env).from("transactions").delete().eq("id", id).eq("user_id", c.get("userId")).select("id"),
    "delete transaction",
  ) as { id: number }[];
  return rows.length ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

api.get("/categories", async (c) => c.json(await listCategories(getDb(c.env), c.get("userId"))));

const CategoryInput = z.object({
  name: z.string().trim().min(1).max(64),
  type: z.enum(TX_TYPES),
  // Emoji/short text only: the icon is embedded in Telegram HTML messages.
  icon: z.string().max(16).regex(/^[^<>&]*$/, "icon may not contain < > &").optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

api.post("/categories", async (c) => {
  const input = await body(c, CategoryInput);
  if (input instanceof Response) return input;
  const { data, error } = await getDb(c.env)
    .from("categories")
    .insert({ ...input, icon: input.icon || "📦", color: input.color ?? "#64748b", user_id: c.get("userId") })
    .select("id,user_id,name,type,icon,color")
    .single();
  if (error) {
    return error.code === "23505"
      ? c.json({ error: "category already exists" }, 409)
      : c.json({ error: "create_failed", message: error.message }, 422);
  }
  return c.json(data as CategoryRow, 201);
});

api.patch("/categories/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const input = await body(c, CategoryInput.partial());
  if (input instanceof Response) return input;
  const { data, error } = await getDb(c.env)
    .from("categories")
    .update(input)
    .eq("id", id)
    .eq("user_id", c.get("userId")) // built-in categories (user_id null) are read-only
    .select("id,user_id,name,type,icon,color")
    .maybeSingle();
  if (error) return c.json({ error: "update_failed", message: error.message }, 422);
  return data ? c.json(data) : c.json({ error: "not_found_or_builtin" }, 404);
});

api.delete("/categories/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const rows = must(
    await getDb(c.env).from("categories").delete().eq("id", id).eq("user_id", c.get("userId")).select("id"),
    "delete category",
  ) as { id: number }[];
  return rows.length ? c.body(null, 204) : c.json({ error: "not_found_or_builtin" }, 404);
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

api.get("/reminders", async (c) => {
  const statuses =
    c.req.query("status") === "all" ? ["pending", "sending", "sent", "failed", "cancelled"] : ["pending", "sending"];
  return c.json(await listReminders(getDb(c.env), c.get("userId"), statuses));
});

const ReminderInput = z.object({
  task: z.string().trim().min(1).max(255),
  remind_at: z.string().min(10),
  recurrence: z.enum(["none", "daily", "weekly", "monthly"]).default("none"),
  amount: z.number().positive().nullable().optional(),
});

api.post("/reminders", async (c) => {
  const input = await body(c, ReminderInput);
  if (input instanceof Response) return input;
  const user = await currentUser(c);
  const at = parseAiDateTime(input.remind_at, safeTz(user.timezone), new Date(0));
  if (at.getTime() <= Date.now()) return c.json({ error: "remind_at must be in the future" }, 422);
  const reminder = await createReminder(getDb(c.env), user, {
    task: input.task,
    remind_at: at.toISOString(),
    recurrence: input.recurrence,
    amount: input.amount ?? null,
  });
  return c.json(reminder, 201);
});

api.delete("/reminders/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const ok = await cancelReminder(getDb(c.env), c.get("userId"), id);
  return ok ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});

// ---------------------------------------------------------------------------
// People (owner only): who may use the bot
// ---------------------------------------------------------------------------

function ownerOnly(c: Context<AppContext>): Response | null {
  return c.get("isOwner") ? null : c.json({ error: "owner_only", message: "Only the bot owner can manage people." }, 403);
}

function telegramIdParam(c: Context<AppContext>): number | null {
  const id = Number(c.req.param("telegramId"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Message someone through the bot (best effort: they may never have opened it, or may have blocked it). */
async function tellUser(c: Context<AppContext>, telegramId: number, html: string): Promise<boolean> {
  if (!c.env.TELEGRAM_BOT_TOKEN) return false;
  try {
    await new Api(c.env.TELEGRAM_BOT_TOKEN).sendMessage(telegramId, html, { parse_mode: "HTML" });
    return true;
  } catch {
    return false;
  }
}

api.get("/admin/users", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const db = getDb(c.env);
  const owners = [...ownerTelegramIds(c.env)];
  const people = await listAllowedUsers(db);
  const ids = [...new Set([...owners, ...people.map((p) => Number(p.telegram_id))])];
  // Which of them have actually started using the bot (they have a users row)?
  const started = ids.length
    ? (must(
        await db.from("users").select("telegram_id,first_name,username,created_at").in("telegram_id", ids),
        "load started users",
      ) as { telegram_id: number; first_name: string | null; username: string | null; created_at: string }[])
    : [];
  const byId = new Map(started.map((u) => [Number(u.telegram_id), u]));
  return c.json({
    open_mode: owners.length === 0,
    owners: owners.map((id) => ({
      telegram_id: id,
      name: byId.get(id)?.first_name ?? null,
      username: byId.get(id)?.username ?? null,
      started_at: byId.get(id)?.created_at ?? null,
      is_me: id === Number(c.get("user").telegram_id),
    })),
    people: people
      .filter((p) => !owners.includes(Number(p.telegram_id)))
      .map((p) => ({
        ...p,
        telegram_id: Number(p.telegram_id),
        name: p.name ?? byId.get(Number(p.telegram_id))?.first_name ?? null,
        username: p.username ?? byId.get(Number(p.telegram_id))?.username ?? null,
        started_at: byId.get(Number(p.telegram_id))?.created_at ?? null,
      })),
  });
});

const AddPerson = z.object({
  telegram_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().max(64).optional(),
});

api.post("/admin/users", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const input = await body(c, AddPerson);
  if (input instanceof Response) return input;
  if (ownerTelegramIds(c.env).has(input.telegram_id)) {
    return c.json({ error: "already_owner", message: "That ID is already an owner." }, 409);
  }
  const before = await approveUser(getDb(c.env), input.telegram_id, Number(c.get("user").telegram_id), input.name || null);
  // If they already asked (pending), tell them they're in. Otherwise they find out when they message the bot.
  const notified = before === "pending" ? await tellUser(c, input.telegram_id, APPROVED_MESSAGE) : false;
  return c.json({ ok: true, previous: before, notified }, 201);
});

const PersonPatch = z.object({ status: z.enum(["approved", "blocked"]) });

api.patch("/admin/users/:telegramId", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const id = telegramIdParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const input = await body(c, PersonPatch);
  if (input instanceof Response) return input;
  const db = getDb(c.env);
  const me = Number(c.get("user").telegram_id);
  if (input.status === "approved") {
    const before = await approveUser(db, id, me);
    const notified = before !== "approved" ? await tellUser(c, id, APPROVED_MESSAGE) : false;
    return c.json({ ok: true, notified });
  }
  await blockUser(db, id, me);
  return c.json({ ok: true });
});

api.delete("/admin/users/:telegramId", async (c) => {
  const denied = ownerOnly(c);
  if (denied) return denied;
  const id = telegramIdParam(c);
  if (!id) return c.json({ error: "not_found" }, 404);
  const removed = await removeAllowedUser(getDb(c.env), id);
  return removed ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
});