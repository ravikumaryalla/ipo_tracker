-- Expo push tokens, one row per device. A separate table rather than a
-- column on profiles since one account can have the app on more than one
-- phone. check-allotments reads this with the service-role client (bypasses
-- RLS, same as everything else that function already touches); the app only
-- ever manages its own rows.

create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null,
  created_at timestamptz not null default now(),
  unique (user_id, token)
);

comment on table public.push_tokens is
  'Expo push tokens, one row per device that has notifications enabled.';

alter table public.push_tokens enable row level security;

create policy "push_tokens: manage own"
  on public.push_tokens for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
