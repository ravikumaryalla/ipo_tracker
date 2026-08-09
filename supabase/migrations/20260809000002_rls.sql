-- Row Level Security.
--
-- Encryption is the primary defence for credentials; RLS is the second line and
-- the ONLY defence for non-secret data (nicknames, application amounts, P&L).
-- Every user-owned table gets RLS enabled with no permissive fallback.

alter table public.profiles           enable row level security;
alter table public.brokers            enable row level security;
alter table public.demat_accounts     enable row level security;
alter table public.ipos               enable row level security;
alter table public.ipo_applications   enable row level security;
alter table public.credential_history enable row level security;
alter table public.sync_log           enable row level security;

-- profiles: you, and only you
create policy "profiles: read own"   on public.profiles
  for select using (auth.uid() = id);
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- brokers: shared reference data. Readable by any signed-in user, written only
-- by the service role (which bypasses RLS entirely).
create policy "brokers: read all" on public.brokers
  for select to authenticated using (true);

-- demat_accounts: the vault
create policy "accounts: read own"   on public.demat_accounts
  for select using (auth.uid() = user_id);
create policy "accounts: insert own" on public.demat_accounts
  for insert with check (auth.uid() = user_id);
create policy "accounts: update own" on public.demat_accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "accounts: delete own" on public.demat_accounts
  for delete using (auth.uid() = user_id);

-- ipos: synced rows (created_by is null) are public reference data. Manually
-- added rows belong to their creator.
create policy "ipos: read shared or own" on public.ipos
  for select to authenticated using (created_by is null or auth.uid() = created_by);
create policy "ipos: insert own manual"  on public.ipos
  for insert to authenticated with check (auth.uid() = created_by);
create policy "ipos: update own manual"  on public.ipos
  for update to authenticated using (auth.uid() = created_by)
                                with check (auth.uid() = created_by);
create policy "ipos: delete own manual"  on public.ipos
  for delete to authenticated using (auth.uid() = created_by);

-- ipo_applications
create policy "applications: read own"   on public.ipo_applications
  for select using (auth.uid() = user_id);
create policy "applications: insert own" on public.ipo_applications
  for insert with check (auth.uid() = user_id);
create policy "applications: update own" on public.ipo_applications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "applications: delete own" on public.ipo_applications
  for delete using (auth.uid() = user_id);

-- credential_history: readable and writable by owner, never updatable (append-only)
create policy "history: read own"   on public.credential_history
  for select using (auth.uid() = user_id);
create policy "history: insert own" on public.credential_history
  for insert with check (auth.uid() = user_id);
create policy "history: delete own" on public.credential_history
  for delete using (auth.uid() = user_id);

-- sync_log: readable by all signed-in users so the app can show a staleness
-- banner. Written only by the Edge Function via the service role.
create policy "sync_log: read all" on public.sync_log
  for select to authenticated using (true);
