-- Catatku: people allowed to use the bot, managed from the dashboard (Users page) or the
-- Telegram "Izinkan" button. Safe to run more than once.
--
-- Owners are the IDs in the Cloudflare secret ALLOWED_TELEGRAM_IDS; they don't need a row here.
-- Everyone else needs a row with status 'approved'.

create table if not exists public.allowed_users (
  telegram_id   bigint      primary key,
  name          text,                          -- label set by the owner, or the person's Telegram name
  username      text,                          -- Telegram @username, if any
  status        text        not null default 'pending'
                check (status in ('pending','approved','blocked')),
  added_by      bigint,                        -- owner's Telegram ID who approved/added them
  requested_at  timestamptz,                   -- when they first messaged the bot (access request)
  decided_at    timestamptz,                   -- when an owner approved or blocked them
  created_at    timestamptz not null default now()
);
create index if not exists ix_allowed_users_status on public.allowed_users (status);

alter table public.allowed_users enable row level security;
