-- Catatku schema for Supabase (PostgreSQL 15+).
-- Run with `supabase db push`, or paste into the Supabase SQL Editor.
--
-- Security model: the Cloudflare Worker is the only client and connects with the
-- Supabase *secret* (service_role) key, which bypasses RLS. RLS is enabled on every
-- table with NO policies, and the functions are revoked from anon/authenticated, so
-- the public anon/publishable key can read or change nothing.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.users (
  id               bigint generated always as identity primary key,
  telegram_id      bigint       not null unique,
  telegram_chat_id bigint       not null,
  username         text,
  first_name       text,
  currency         text         not null default 'IDR',
  timezone         text         not null default 'Asia/Jakarta',
  monthly_budget   numeric(16,2) not null default 0 check (monthly_budget >= 0),
  initial_balance  numeric(16,2) not null default 0,
  created_at       timestamptz  not null default now()
);

create table if not exists public.categories (
  id          bigint generated always as identity primary key,
  user_id     bigint references public.users(id) on delete cascade,  -- null = built-in
  name        text not null,
  type        text not null default 'expense' check (type in ('expense','income','transfer','debt')),
  icon        text not null default '📦',
  color       text not null default '#64748b',
  created_at  timestamptz not null default now(),
  constraint uq_category_user_name unique nulls not distinct (user_id, name)
);
create index if not exists ix_categories_user_id on public.categories (user_id);

create table if not exists public.transactions (
  id                bigint generated always as identity primary key,
  user_id           bigint       not null references public.users(id) on delete cascade,
  type              text         not null check (type in ('expense','income','transfer','debt')),
  amount            numeric(16,2) not null check (amount > 0),
  category_id       bigint references public.categories(id) on delete set null,
  description       text         not null default '',
  merchant          text,
  payment_method    text         not null default 'Tunai',
  debt_direction    text check (debt_direction in ('borrow','repay','lend','collect')),
  counterparty      text,
  transaction_date  timestamptz  not null default now(),
  source            text         not null default 'telegram_text'
                    check (source in ('telegram_text','telegram_voice','telegram_receipt','dashboard')),
  raw_input         text,
  receipt_data      jsonb,
  created_at        timestamptz  not null default now(),
  constraint ck_debt_requires_direction check (type <> 'debt' or debt_direction is not null)
);
create index if not exists ix_transactions_user_date on public.transactions (user_id, transaction_date desc);
create index if not exists ix_transactions_category on public.transactions (category_id);

create table if not exists public.reminders (
  id            bigint generated always as identity primary key,
  user_id       bigint      not null references public.users(id) on delete cascade,
  task          text        not null,
  amount        numeric(16,2),
  remind_at     timestamptz not null,            -- next fire time
  anchor_at     timestamptz not null,            -- first fire time; recurrences step from here
  occurrence    integer     not null default 0,  -- how many recurrences have been scheduled
  recurrence    text        not null default 'none' check (recurrence in ('none','daily','weekly','monthly')),
  status        text        not null default 'pending'
                check (status in ('pending','sending','sent','failed','cancelled')),
  attempts      integer     not null default 0,
  claimed_at    timestamptz,
  last_sent_at  timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);
create index if not exists ix_reminders_due on public.reminders (status, remind_at);
create index if not exists ix_reminders_user on public.reminders (user_id);

create table if not exists public.ai_insights (
  id          bigint generated always as identity primary key,
  user_id     bigint     not null references public.users(id) on delete cascade,
  period      text       not null,   -- YYYY-MM
  content     jsonb      not null,
  updated_at  timestamptz not null default now(),
  constraint uq_insight_user_period unique (user_id, period)
);

-- One-time dashboard login links issued by the bot (/dashboard). Only the SHA-256 hash is stored.
create table if not exists public.login_tokens (
  token_hash  text primary key,
  user_id     bigint      not null references public.users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists ix_login_tokens_expires on public.login_tokens (expires_at);

alter table public.users        enable row level security;
alter table public.categories   enable row level security;
alter table public.transactions enable row level security;
alter table public.reminders    enable row level security;
alter table public.ai_insights  enable row level security;
alter table public.login_tokens enable row level security;
-- ---------------------------------------------------------------------------
-- Built-in categories
-- ---------------------------------------------------------------------------

insert into public.categories (user_id, name, type, icon, color) values
  (null, 'Makanan & Minuman', 'expense', '🍔', '#f97316'),
  (null, 'Transportasi',      'expense', '🚗', '#3b82f6'),
  (null, 'Belanja',           'expense', '🛍️', '#ec4899'),
  (null, 'Tagihan & Utilitas','expense', '💡', '#eab308'),
  (null, 'Pulsa & Internet',  'expense', '📱', '#14b8a6'),
  (null, 'Hiburan',           'expense', '🎬', '#8b5cf6'),
  (null, 'Kesehatan',         'expense', '💊', '#ef4444'),
  (null, 'Pendidikan',        'expense', '📚', '#06b6d4'),
  (null, 'Rumah Tangga',      'expense', '🏠', '#84cc16'),
  (null, 'Perawatan Diri',    'expense', '💇', '#d946ef'),
  (null, 'Sosial & Donasi',   'expense', '🤲', '#f43f5e'),
  (null, 'Lainnya',           'expense', '📦', '#64748b'),
  (null, 'Gaji',              'income',  '💼', '#22c55e'),
  (null, 'Bonus',             'income',  '🎉', '#10b981'),
  (null, 'Bisnis',            'income',  '📈', '#0ea5e9'),
  (null, 'Investasi',         'income',  '💹', '#6366f1'),
  (null, 'Hadiah',            'income',  '🎁', '#a855f7'),
  (null, 'Pemasukan Lain',    'income',  '💰', '#16a34a'),
  (null, 'Transfer',          'transfer','🔁', '#94a3b8'),
  (null, 'Utang Piutang',     'debt',    '🤝', '#f59e0b')
on conflict on constraint uq_category_user_name do nothing;

-- ---------------------------------------------------------------------------
-- Ledger functions
-- ---------------------------------------------------------------------------

-- Effect of one transaction on the cash balance.
--   income +, expense -, transfer 0 (moves money between your own accounts),
--   debt/borrow + (you received borrowed money), debt/repay - (you paid it back),
--   debt/lend - (you lent money out), debt/collect + (it was paid back to you).
create or replace function public.signed_amount(p_type text, p_direction text, p_amount numeric)
returns numeric language sql immutable as $$
  select case
    when p_type = 'income'  then p_amount
    when p_type = 'expense' then -p_amount
    when p_type = 'debt' and p_direction in ('borrow','collect') then p_amount
    when p_type = 'debt' and p_direction in ('repay','lend')     then -p_amount
    else 0
  end
$$;

create or replace function public.get_balance(p_user_id bigint)
returns numeric language sql stable as $$
  select u.initial_balance + coalesce((
    select sum(public.signed_amount(t.type, t.debt_direction, t.amount))
    from public.transactions t where t.user_id = u.id
  ), 0)
  from public.users u where u.id = p_user_id
$$;

-- Outstanding debt you owe (borrow - repay) and receivables owed to you (lend - collect).
create or replace function public.get_debt_totals(p_user_id bigint)
returns table (total_debt numeric, total_receivable numeric) language sql stable as $$
  select
    greatest(coalesce(sum(case when debt_direction = 'borrow' then amount
                               when debt_direction = 'repay'  then -amount end), 0), 0),
    greatest(coalesce(sum(case when debt_direction = 'lend'    then amount
                               when debt_direction = 'collect' then -amount end), 0), 0)
  from public.transactions
  where user_id = p_user_id and type = 'debt'
$$;

-- Everything the dashboard overview needs for one calendar month, in the user's timezone.
create or replace function public.dashboard_summary(p_user_id bigint, p_year int, p_month int)
returns jsonb language plpgsql stable as $$
declare
  v_user        public.users%rowtype;
  v_local_start timestamp := make_timestamp(p_year, p_month, 1, 0, 0, 0);
  v_start       timestamptz;
  v_end         timestamptz;
  v_prev_start  timestamptz;
  v_income      numeric;
  v_expense     numeric;
  v_prev_income numeric;
  v_prev_expense numeric;
  v_count       int;
  v_debt        numeric;
  v_receivable  numeric;
begin
  select * into v_user from public.users where id = p_user_id;
  if not found then
    return null;
  end if;

  v_start      := v_local_start at time zone v_user.timezone;
  v_end        := (v_local_start + interval '1 month') at time zone v_user.timezone;
  v_prev_start := (v_local_start - interval '1 month') at time zone v_user.timezone;

  select coalesce(sum(amount) filter (where type = 'income'), 0),
         coalesce(sum(amount) filter (where type = 'expense'), 0),
         count(*)
    into v_income, v_expense, v_count
  from public.transactions
  where user_id = p_user_id and transaction_date >= v_start and transaction_date < v_end;

  select coalesce(sum(amount) filter (where type = 'income'), 0),
         coalesce(sum(amount) filter (where type = 'expense'), 0)
    into v_prev_income, v_prev_expense
  from public.transactions
  where user_id = p_user_id and transaction_date >= v_prev_start and transaction_date < v_start;

  select d.total_debt, d.total_receivable into v_debt, v_receivable
  from public.get_debt_totals(p_user_id) d;

  return jsonb_build_object(
    'period',             to_char(v_local_start, 'YYYY-MM'),
    'currency',           v_user.currency,
    'timezone',           v_user.timezone,
    'balance',            public.get_balance(p_user_id),
    'monthly_income',     v_income,
    'monthly_expense',    v_expense,
    'net_monthly',        v_income - v_expense,
    'prev_month_income',  v_prev_income,
    'prev_month_expense', v_prev_expense,
    'total_debt',         v_debt,
    'total_receivable',   v_receivable,
    'transaction_count',  v_count,
    'budget', case when v_user.monthly_budget > 0 then jsonb_build_object(
        'amount',    v_user.monthly_budget,
        'spent',     v_expense,
        'remaining', v_user.monthly_budget - v_expense,
        'percent',   round(v_expense / v_user.monthly_budget * 100, 1)
      ) else null end,
    'category_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object(
               'category_id', x.category_id, 'name', x.name, 'icon', x.icon, 'color', x.color,
               'total', x.total, 'count', x.cnt,
               'percent', case when v_expense > 0 then round(x.total / v_expense * 100, 1) else 0 end
             ) order by x.total desc)
      from (
        select t.category_id,
               coalesce(c.name, 'Tanpa Kategori') as name,
               coalesce(c.icon, '❔') as icon,
               coalesce(c.color, '#94a3b8') as color,
               sum(t.amount) as total, count(*) as cnt
        from public.transactions t
        left join public.categories c on c.id = t.category_id
        where t.user_id = p_user_id and t.type = 'expense'
          and t.transaction_date >= v_start and t.transaction_date < v_end
        group by t.category_id, c.name, c.icon, c.color
      ) x
    ), '[]'::jsonb),
    'daily', (
      select jsonb_agg(jsonb_build_object(
               'date', to_char(d.day, 'YYYY-MM-DD'),
               'income', coalesce(s.income, 0),
               'expense', coalesce(s.expense, 0)
             ) order by d.day)
      -- timestamp (not timestamptz) series: one row per local calendar day, independent of the session TimeZone
      from generate_series(v_local_start,
                           v_local_start + interval '1 month' - interval '1 day',
                           interval '1 day') as d(day)
      left join (
        select (t.transaction_date at time zone v_user.timezone)::date as day,
               sum(t.amount) filter (where t.type = 'income')  as income,
               sum(t.amount) filter (where t.type = 'expense') as expense
        from public.transactions t
        where t.user_id = p_user_id and t.transaction_date >= v_start and t.transaction_date < v_end
        group by 1
      ) s on s.day = d.day::date
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reminder dispatch (called by the Worker's per-minute Cron Trigger)
-- ---------------------------------------------------------------------------

-- Atomically claim due reminders. Rows stuck in 'sending' for >5 min (crashed run) are reclaimed.
create or replace function public.claim_due_reminders(p_limit int default 50)
returns setof public.reminders language sql volatile as $$
  update public.reminders r
     set status = 'sending', claimed_at = now(), attempts = r.attempts + 1
   where r.id in (
     select id from public.reminders
      where (status = 'pending' and remind_at <= now())
         or (status = 'sending' and claimed_at < now() - interval '5 minutes')
      order by remind_at
      limit p_limit
      for update skip locked
   )
  returning r.*;
$$;

-- Record the outcome of a delivery attempt and schedule the next occurrence of recurring reminders.
create or replace function public.finish_reminder(
  p_id bigint, p_success boolean, p_error text default null, p_permanent boolean default false
) returns void language plpgsql volatile as $$
declare
  r      public.reminders%rowtype;
  v_tz   text;
  v_step interval;
  v_n    int;
  v_next timestamptz;
begin
  select * into r from public.reminders where id = p_id for update;
  if not found then return; end if;
  select timezone into v_tz from public.users where id = r.user_id;

  if not p_success then
    if p_permanent or r.attempts >= 5 then
      update public.reminders set status = 'failed', last_error = p_error, claimed_at = null where id = p_id;
    else
      -- retry with linear backoff: 2, 4, 6, 8 minutes
      update public.reminders
         set status = 'pending', last_error = p_error, claimed_at = null,
             remind_at = now() + (r.attempts * interval '2 minutes')
       where id = p_id;
    end if;
    return;
  end if;

  if r.recurrence = 'none' then
    update public.reminders
       set status = 'sent', last_sent_at = now(), claimed_at = null, last_error = null
     where id = p_id;
    return;
  end if;

  v_step := case r.recurrence when 'daily' then interval '1 day'
                              when 'weekly' then interval '1 week'
                              else interval '1 month' end;
  v_n := r.occurrence;
  loop
    v_n := v_n + 1;
    -- Step from the anchor in local wall-clock time: keeps "09:00 on the 31st" stable across DST/short months.
    v_next := ((r.anchor_at at time zone v_tz) + v_n * v_step) at time zone v_tz;
    exit when v_next > now();
  end loop;

  update public.reminders
     set status = 'pending', remind_at = v_next, occurrence = v_n, attempts = 0,
         last_sent_at = now(), claimed_at = null, last_error = null
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock functions down to the service role (the Worker).
-- ---------------------------------------------------------------------------

revoke all on function public.signed_amount(text, text, numeric)           from public, anon, authenticated;
revoke all on function public.get_balance(bigint)                          from public, anon, authenticated;
revoke all on function public.get_debt_totals(bigint)                      from public, anon, authenticated;
revoke all on function public.dashboard_summary(bigint, int, int)          from public, anon, authenticated;
revoke all on function public.claim_due_reminders(int)                     from public, anon, authenticated;
revoke all on function public.finish_reminder(bigint, boolean, text, boolean) from public, anon, authenticated;

grant execute on function public.signed_amount(text, text, numeric)           to service_role;
grant execute on function public.get_balance(bigint)                          to service_role;
grant execute on function public.get_debt_totals(bigint)                      to service_role;
grant execute on function public.dashboard_summary(bigint, int, int)          to service_role;
grant execute on function public.claim_due_reminders(int)                     to service_role;
grant execute on function public.finish_reminder(bigint, boolean, text, boolean) to service_role;