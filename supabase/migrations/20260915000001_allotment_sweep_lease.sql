-- Schema the tightened allotment sweep needs. The cron change itself is the
-- next migration, kept separate because schema-all-in-one.sql excludes
-- ..._cron_*.sql (those need the Edge Function deployed first) and these two
-- objects must reach a fresh project either way.
--
-- Context: the sweep used to run 21:00 IST to midnight on allotment_date every
-- 15 minutes. It now runs 21:00 IST to 08:00 IST the next morning, every two
-- minutes until midnight and every five after — see
-- 20260915000002_cron_check_allotments_2min.sql and
-- supabase/functions/check-allotments/parse.ts#isAllotmentCheckDue.

-- ---------------------------------------------------------------------------
-- Only one sweep at a time.
--
-- A sweep can run for the best part of two minutes (BIGSHARE_RUN_DEADLINE_MS
-- is 110s), so at a two-minute cadence overlapping invocations would be
-- routine rather than exceptional. Bigshare request pacing and the block
-- circuit-breaker both live inside a single invocation, so two concurrent
-- sweeps would quietly double the request rate at the one endpoint that has
-- actually blocked us before — and could send the same allotment push twice.
--
-- check-allotments claims this row with a conditional UPDATE, which is what
-- makes it a lock rather than a hint: Postgres serialises the two writes, so
-- only one caller can find a still-expired locked_until. The timestamp is a
-- lease rather than a boolean so a sweep whose isolate dies cannot wedge the
-- job forever.
-- ---------------------------------------------------------------------------
create table if not exists public.job_leases (
  name         text primary key,
  locked_until timestamptz not null default now()
);

insert into public.job_leases (name, locked_until)
values ('check-allotments', now())
on conflict (name) do nothing;

-- No policies, deliberately: the service role bypasses RLS, and nothing else
-- has any business reading or taking a job lease.
alter table public.job_leases enable row level security;

-- Both the cron guard in the next migration and check-allotments' own
-- candidate query filter on status; the only indexes on this table are
-- user_id and ipo_id (20260809000001_init.sql). Partial, because 'APPLIED' is
-- the only status either of them ever asks for.
create index if not exists ipo_applications_applied_idx
  on public.ipo_applications (ipo_id)
  where status = 'APPLIED';

-- ---------------------------------------------------------------------------
-- Latest sync_log row per provider.
--
-- latestSyncStatus() used to read the newest 45 rows and dedupe client-side, a
-- count picked to cover roughly two sync-ipos runs. ALLOTMENT_CHECK now logs
-- on every sweep that checks anything, which would have filled that 45 and
-- hidden every other provider from the staleness banner on exactly the nights
-- a sweep is running. distinct on retires the row count for good.
--
-- security_invoker = on, like v_application_pnl and v_ipo_latest_gmp, so
-- sync_log's own "readable by all signed-in users" policy keeps applying
-- rather than being bypassed by the view's owner.
-- ---------------------------------------------------------------------------
create or replace view public.v_latest_sync_status
with (security_invoker = on)
as
select distinct on (provider) *
from public.sync_log
order by provider, ran_at desc;
