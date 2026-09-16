-- Turns the allotment sweep from "check everyone's allotment" into "watch for
-- the result being published".
--
-- Until now the sweep resolved each APPLIED application against the registrar
-- with the applicant's PAN and pushed the outcome. The notification was the
-- answer, which made the app a place to confirm what you already knew. It also
-- meant one PAN-bearing registrar request per application every two minutes,
-- all night.
--
-- Now the sweep only answers a per-IPO question — has this issue's allotment
-- been published? — by looking for it in Bigshare's and MUFG's public company
-- dropdowns, which list only issues currently open to an allotment query (see
-- supabase/functions/check-allotments/registrarWatch.ts). When it appears,
-- everyone who applied gets one "results are out" push and runs the real check
-- themselves from the app. No PAN leaves the database on a schedule any more.
--
-- KFintech has no equivalent signal: its dropdown is a full directory baked
-- into a JS bundle, carrying only {clientId, name}. KFintech issues therefore
-- never set allotment_out_at and never notify — the in-app "Check" button stays
-- the only path for them.

alter table public.ipos
  -- First tick that found the issue in a registrar's list. Non-null retires the
  -- IPO from the watch set for good.
  add column if not exists allotment_out_at      timestamptz,
  -- Set once the push fan-out has run. Kept separate from allotment_out_at so a
  -- detection that lands during an Expo outage re-notifies on the next tick
  -- instead of being lost: one column cannot mean both "found" and "told".
  add column if not exists allotment_notified_at timestamptz,
  -- Cadence stamp, stamped on every attempt. Takes over the scheduling role
  -- ipo_applications.allotment_checked_at played, which is what lets
  -- parse.ts#isAllotmentCheckDue stay exactly as it is while becoming a
  -- per-IPO gate rather than a per-application one.
  add column if not exists allotment_probed_at   timestamptz;

comment on column public.ipos.allotment_out_at is
  'When a registrar first listed this issue as open to allotment queries. Null = still waiting.';
comment on column public.ipos.allotment_notified_at is
  'When the "results are out" push fan-out last completed for this issue.';
comment on column public.ipos.allotment_probed_at is
  'When the watch last looked for this issue, successful or not. Drives the recheck cadence.';

-- The watch selects on allotment_notified_at, not allotment_out_at: the two
-- columns exist so that finding a result and announcing it can fail
-- independently, and an issue detected on one tick whose push then failed has
-- to come back on the next one. So that is the predicate the index carries.
create index if not exists ipos_awaiting_allotment_idx
  on public.ipos (allotment_date) where allotment_notified_at is null;

-- Same function as 20260915000002, with one extra clause on the pre-filter: an
-- IPO that has already been announced must stop waking the Edge Function for
-- the rest of its ±1 day window. Without it, every detection would keep paying
-- for a wasted HTTP call a minute until the date rolled past.
--
-- Deliberately allotment_notified_at and not allotment_out_at, matching the
-- watch query in the Edge Function: an issue that was detected but whose push
-- failed still needs the function woken to retry the announcement.
create or replace function public.trigger_check_allotments()
returns void
language plpgsql
as $$
declare
  base text := 'https://mevqsxjmxpdbbqtamjgr.supabase.co';
  key  text;
begin
  -- Cheap pre-filter for the per-minute cadence. current_date is UTC here and
  -- the 21:00→08:00 IST window straddles two UTC dates, so ±1 day of slack
  -- covers it with room to spare. The precise gate stays in TypeScript — this
  -- only has to be right about which nights are worth waking the function for.
  if not exists (
    select 1
    from public.ipo_applications a
    join public.ipos i on i.id = a.ipo_id
    where a.status = 'APPLIED'
      and i.allotment_date between current_date - 1 and current_date + 1
      and i.allotment_notified_at is null
  ) then
    return;
  end if;

  -- Unchanged from 20260811000008: the project URL is hardcoded for the same
  -- reason trigger_sync_ipos() does it — app.settings.* GUCs don't work on
  -- hosted Supabase.
  select decrypted_secret into key
    from vault.decrypted_secrets
    where name = 'service_role_key'
    limit 1;

  if coalesce(key, '') = '' then
    insert into public.sync_log (provider, ok, rows_upserted, message)
    values ('CRON', false, 0,
      'No Vault secret named ''service_role_key'' found. Run, once, as a superuser in the SQL editor: '
      || 'select vault.create_secret(''YOUR-SERVICE-ROLE-KEY'', ''service_role_key'');');
    return;
  end if;

  perform net.http_post(
    url     := base || '/functions/v1/check-allotments',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || key
    ),
    body    := '{}'::jsonb
  );
end;
$$;

revoke all on function public.trigger_check_allotments() from public;
revoke all on function public.trigger_check_allotments() from anon, authenticated;
