-- KFintech is the assumed default registrar for every synced IPO — most
-- mainboard issues use it, and there's no signal in the ipowatch/NSE/BSE
-- feeds to say otherwise. kfintech_company_id (needed for the actual
-- per-PAN allotment check) is still only set by syncKfintechCompanies's
-- name-match in supabase/functions/sync-ipos/index.ts; this default just
-- means every IPO gets a registrar and an allotment link immediately
-- instead of waiting on that match to succeed.
alter table public.ipos
  alter column registrar set default 'KFINTECH',
  alter column registrar_url set default 'https://ipostatus.kfintech.com/';

-- Backfill: apply the same default to synced rows that predate this
-- migration and never got a registrar (no match yet, or matching failed).
-- created_by is null keeps this scoped to synced rows — a user's own
-- manually-added IPO is never touched.
update public.ipos
set registrar = 'KFINTECH',
    registrar_url = 'https://ipostatus.kfintech.com/'
where registrar is null
  and created_by is null;
