-- push_tokens gains a lifecycle. The app now registers a token silently on
-- sign-in (not only when the Profile toggle is flipped) and re-registers on OS
-- token rotation, so the same row gets rewritten often. These columns make that
-- observable and give the sender something to prune against:
--
--   platform     - 'android' | 'ios' | 'web'; handy when a token misbehaves and
--                  you are staring at a table of opaque ExponentPushToken[...].
--   last_seen_at  - bumped on every (re)registration; a stale value is a device
--                  that has not opened the app in a long time.
--   updated_at    - kept honest by the shared touch_updated_at() trigger, same
--                  as profiles / demat_accounts / ipos / ipo_applications.
--
-- All nullable / defaulted, so existing rows need no backfill. RLS is unchanged
-- ("manage own" already covers every column).

alter table public.push_tokens
  add column if not exists platform     text,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists updated_at   timestamptz not null default now();

create trigger push_tokens_touch before update on public.push_tokens
  for each row execute function public.touch_updated_at();
