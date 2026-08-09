-- Schedule the IPO sync — supersedes 20260809000004_cron.sql.
--
-- 04:00 UTC = 09:30 IST (before the market opens) and 13:30 UTC = 19:00 IST
-- (after it closes). Those two times differ in their MINUTE, and a cron
-- expression has exactly one minute field, so this is genuinely two jobs. The
-- previous single expression '0 4,13 * * *' could not express :30 and silently
-- ran the evening job at 18:30 IST — half an hour earlier than its own comment
-- claimed.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- ---------------------------------------------------------------------------
-- One place that knows how to call the function, so the two schedules cannot
-- drift apart.
--
-- The footgun this closes: the URL and key live in database settings that only
-- a superuser `alter database` can set, and `current_setting('x')` RAISES when
-- the setting is absent. `db push` alone therefore produced a job that threw on
-- every tick into cron.job_run_details — a table nothing in the app looks at.
--
-- `current_setting(name, true)` returns NULL instead of raising, so a
-- misconfiguration becomes a sync_log row, which the IPOs tab's existing
-- staleness banner already renders. Broken config now looks broken.
-- ---------------------------------------------------------------------------
create or replace function public.trigger_sync_ipos()
returns void
language plpgsql
as $$
declare
  base text := current_setting('app.settings.supabase_url', true);
  key  text := current_setting('app.settings.service_role_key', true);
begin
  if coalesce(base, '') = '' or coalesce(key, '') = '' then
    insert into public.sync_log (provider, ok, rows_upserted, message)
    values ('CRON', false, 0,
      'app.settings.supabase_url / app.settings.service_role_key are not set. '
      || 'Run the alter-database statements at the bottom of '
      || 'supabase/migrations/20260810000002_cron.sql as a superuser.');
    return;
  end if;

  perform net.http_post(
    url     := base || '/functions/v1/sync-ipos',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || key
    ),
    body    := '{}'::jsonb
  );
end;
$$;

-- Deliberately NOT security definer: the job runs as the scheduling superuser
-- via pg_cron, and an invoker-rights function cannot be turned into a
-- service-key oracle by an authenticated user. Revoke anyway — nothing but the
-- cron owner should be able to fire a sync.
revoke all on function public.trigger_sync_ipos() from public;
revoke all on function public.trigger_sync_ipos() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reschedule. Idempotent: the guard makes re-applying this file safe, and
-- cron.schedule() upserts by jobname.
-- ---------------------------------------------------------------------------
select cron.unschedule('sync-ipos')
where exists (select 1 from cron.job where jobname = 'sync-ipos');

select cron.schedule('sync-ipos-morning', '0 4 * * *',
                     $$ select public.trigger_sync_ipos(); $$);   -- 09:30 IST
select cron.schedule('sync-ipos-evening', '30 13 * * *',
                     $$ select public.trigger_sync_ipos(); $$);   -- 19:00 IST

-- ---------------------------------------------------------------------------
-- Fail loudly at migration time, not silently at 09:30 tomorrow.
-- ---------------------------------------------------------------------------
do $$
begin
  if coalesce(current_setting('app.settings.supabase_url',     true), '') = ''
  or coalesce(current_setting('app.settings.service_role_key', true), '') = ''
  then
    raise warning 'sync-ipos is scheduled but app.settings.supabase_url / app.settings.service_role_key are unset — every run will no-op and write a CRON failure to sync_log until you set them.';
  end if;
end $$;

-- As a superuser, once per project (Dashboard -> Settings -> API):
--   alter database postgres set app.settings.supabase_url     = 'https://YOUR-REF.supabase.co';
--   alter database postgres set app.settings.service_role_key = 'YOUR-SERVICE-ROLE-KEY';
--   select pg_reload_conf();
--
-- To remove:
--   select cron.unschedule('sync-ipos-morning');
--   select cron.unschedule('sync-ipos-evening');
