-- IPO Tracker — initial schema.
--
-- SECURITY CONTRACT FOR THIS FILE
-- Every column holding a demat credential ends in `_enc` and is TEXT holding
-- base64(nonce || ciphertext) produced on the device with XChaCha20-Poly1305.
-- There is deliberately NO plaintext credential column anywhere in this schema.
-- If a future migration adds one, that is a bug — the server must never be able
-- to read a password.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, holds the public half of the vault crypto
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  display_name      text,
  -- Argon2id salt. A salt is not a secret; storing it lets a reinstall
  -- re-derive the vault key from the master passphrase alone.
  vault_salt        text,
  -- Known plaintext encrypted under the vault key, so a wrong passphrase is
  -- detected up front instead of silently producing garbage.
  vault_verifier    text,
  -- Vault key wrapped under a key derived from the printable recovery code.
  vault_recovery_blob text,
  auto_lock_minutes integer not null default 5 check (auto_lock_minutes between 0 and 1440),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column public.profiles.vault_salt is
  'Argon2id salt (base64). Public by design; the passphrase never leaves the device.';

-- ---------------------------------------------------------------------------
-- brokers: shared reference data, readable by every signed-in user
-- ---------------------------------------------------------------------------
create table public.brokers (
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  slug     text not null unique,
  website  text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- demat_accounts: the vault. Every sensitive field is ciphertext.
-- ---------------------------------------------------------------------------
create table public.demat_accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  broker_id         uuid references public.brokers(id) on delete set null,
  -- Non-secret label so the list can render without unlocking the vault.
  nickname          text not null,
  client_id_enc     text,
  dp_id_enc         text,
  bo_id_enc         text,
  username_enc      text,
  password_enc      text,
  txn_password_enc  text,
  upi_id_enc        text,
  linked_bank_enc   text,
  pan_enc           text,
  notes_enc         text,
  is_active         boolean not null default true,
  opened_on         date,
  password_changed_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index demat_accounts_user_idx on public.demat_accounts(user_id) where is_active;

-- ---------------------------------------------------------------------------
-- ipos: public market data, written only by the sync-ipos Edge Function or by
-- the owning user when they add one manually.
-- ---------------------------------------------------------------------------
create type public.ipo_segment as enum ('MAINBOARD', 'SME');
create type public.ipo_status  as enum ('UPCOMING', 'OPEN', 'CLOSED', 'LISTED', 'WITHDRAWN');

create table public.ipos (
  id              uuid primary key default gen_random_uuid(),
  symbol          text not null,
  company_name    text not null,
  exchange        text not null default 'NSE',
  segment         public.ipo_segment not null default 'MAINBOARD',
  status          public.ipo_status  not null default 'UPCOMING',
  open_date       date,
  close_date      date,
  allotment_date  date,
  listing_date    date,
  price_band_min  numeric(12,2),
  price_band_max  numeric(12,2),
  lot_size        integer check (lot_size > 0),
  issue_size_cr   numeric(14,2),
  listing_price   numeric(12,2),
  current_price   numeric(12,2),
  registrar       text,
  registrar_url   text,
  -- 'NSE' | 'BSE' | 'MANUAL'. NULL user_id means shared/synced data.
  source          text not null default 'MANUAL',
  created_by      uuid references auth.users(id) on delete cascade,
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Upsert key for the sync function. Two IPOs never share symbol + open date.
create unique index ipos_symbol_open_idx on public.ipos(symbol, open_date);
create index ipos_dates_idx on public.ipos(open_date desc nulls last);

-- ---------------------------------------------------------------------------
-- ipo_applications: which of my accounts applied to what
-- ---------------------------------------------------------------------------
create type public.application_category as enum
  ('RETAIL', 'SHNI', 'BHNI', 'SHAREHOLDER', 'EMPLOYEE', 'POLICYHOLDER');
create type public.application_status as enum
  ('APPLIED', 'ALLOTTED', 'PARTIAL', 'NOT_ALLOTTED', 'WITHDRAWN', 'REFUNDED');

create table public.ipo_applications (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  ipo_id              uuid not null references public.ipos(id) on delete cascade,
  demat_account_id    uuid not null references public.demat_accounts(id) on delete cascade,
  category            public.application_category not null default 'RETAIL',
  lots                integer not null check (lots > 0),
  bid_price           numeric(12,2) not null check (bid_price > 0),
  -- Denormalised so history stays correct even if the IPO's lot size is edited.
  shares_applied      integer not null check (shares_applied > 0),
  amount_blocked      numeric(14,2) not null check (amount_blocked >= 0),
  application_no      text,
  upi_ref             text,
  applied_at          timestamptz not null default now(),
  status              public.application_status not null default 'APPLIED',
  shares_allotted     integer not null default 0 check (shares_allotted >= 0),
  allotment_checked_at timestamptz,
  sell_price          numeric(12,2),
  sold_at             timestamptz,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One application per account per category per IPO — matches SEBI rules.
  constraint ipo_applications_unique_bid unique (ipo_id, demat_account_id, category),
  constraint shares_allotted_within_applied check (shares_allotted <= shares_applied)
);

create index ipo_applications_user_idx on public.ipo_applications(user_id);
create index ipo_applications_ipo_idx  on public.ipo_applications(ipo_id);

-- ---------------------------------------------------------------------------
-- credential_history: prior ciphertext, so a bad edit is recoverable
-- ---------------------------------------------------------------------------
create table public.credential_history (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  demat_account_id uuid not null references public.demat_accounts(id) on delete cascade,
  field            text not null,
  old_value_enc    text not null,
  changed_at       timestamptz not null default now()
);

create index credential_history_account_idx
  on public.credential_history(demat_account_id, changed_at desc);

-- ---------------------------------------------------------------------------
-- sync_log: why the IPO list is stale, surfaced in-app instead of failing quietly
-- ---------------------------------------------------------------------------
create table public.sync_log (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  ok          boolean not null,
  rows_upserted integer not null default 0,
  message     text,
  ran_at      timestamptz not null default now()
);

create index sync_log_ran_at_idx on public.sync_log(ran_at desc);

-- ---------------------------------------------------------------------------
-- keep updated_at honest
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch        before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger demat_accounts_touch  before update on public.demat_accounts
  for each row execute function public.touch_updated_at();
create trigger ipos_touch            before update on public.ipos
  for each row execute function public.touch_updated_at();
create trigger ipo_applications_touch before update on public.ipo_applications
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- create a profile row automatically on signup
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
