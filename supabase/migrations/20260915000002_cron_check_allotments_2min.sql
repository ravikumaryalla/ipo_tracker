-- Supersedes the 15-minute job created in
-- 20260814000001_cron_check_allotments_15min.sql.
--
-- The window was one dense evening: 21:00 IST to midnight on allotment_date,
-- checked every 15 minutes — twelve attempts, and nothing at all for a result
-- that slipped past midnight. It is now 21:00 IST to 08:00 IST the next
-- morning, checked every two minutes until midnight and every five after.
--
-- Those two cadences are NOT in this file. IST is UTC+5:30, so both phase
-- boundaries land on :30 UTC, and a cron expression has a single minute field
-- — spelling out "every two minutes from 15:30 to 18:29 UTC, then every five
-- until 02:29" takes about seven separate jobs, which is exactly the kind of
-- drift 20260810000002_cron.sql already had to clean up once. Instead the cron
-- ticks every minute and parse.ts#isAllotmentCheckDue decides, per row, from
-- ipo_applications.allotment_checked_at — a stamp every attempt already
-- writes. Reading the stamp also means a missed tick cannot shift the cadence.
--
-- To keep a per-minute tick cheap, trigger_check_allotments() gains a guard:
-- on the ~1400 ticks a day when no application is anywhere near its
-- allotment_date it returns without an HTTP call at all. Requires
-- 20260915000001_allotment_sweep_lease.sql for ipo_applications_applied_idx.

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

-- Idempotent: the guard makes re-applying this file safe, and cron.schedule()
-- upserts by jobname — same pattern as 20260814000001.
select cron.unschedule('check-allotments-15min')
where exists (select 1 from cron.job where jobname = 'check-allotments-15min');

select cron.schedule('check-allotments-1min', '* * * * *',
                     $$ select public.trigger_check_allotments(); $$);
