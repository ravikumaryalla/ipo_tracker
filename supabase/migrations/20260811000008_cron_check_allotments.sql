-- Hourly cron for check-allotments (see supabase/functions/check-allotments).
-- Same Vault-secret / net.http_post pattern trigger_sync_ipos() already uses
-- (20260811000002_cron_vault.sql) — the project URL is hardcoded there too,
-- for the same reason: app.settings.* GUCs don't work on hosted Supabase.

create or replace function public.trigger_check_allotments()
returns void
language plpgsql
as $$
declare
  base text := 'https://mevqsxjmxpdbbqtamjgr.supabase.co';
  key  text;
begin
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

-- On the hour, every hour. check-allotments itself gates on 19:00 IST on
-- each IPO's allotment_date, so most hourly ticks are no-ops until an IPO
-- actually reaches that point — this cadence is what gives "check again in
-- an hour" its meaning without any extra state to track.
select cron.schedule('check-allotments-hourly', '0 * * * *', $$ select public.trigger_check_allotments(); $$);
