-- Schedule the IPO sync.
--
-- Run this AFTER deploying the Edge Function and setting the two settings
-- below, otherwise the job will fire against a URL that does not exist yet.
--
-- Fill these in for your project (Dashboard → Settings → API), as a superuser:
--   alter database postgres set app.settings.supabase_url        = 'https://YOUR-REF.supabase.co';
--   alter database postgres set app.settings.service_role_key    = 'YOUR-SERVICE-ROLE-KEY';
--
-- The service-role key lives only here, in the database. It must never appear
-- in the app bundle or in .env.

create extension if not exists pg_cron  with schema extensions;
create extension if not exists pg_net   with schema extensions;

/**
 * Twice daily, at 04:00 and 13:30 UTC — that is 09:30 and 19:00 IST, which
 * brackets the Indian market day, so the list is fresh before the market opens
 * and again after it closes.
 */
select cron.schedule(
  'sync-ipos',
  '0 4,13 * * *',
  $$
  select net.http_post(
    url     := current_setting('app.settings.supabase_url') || '/functions/v1/sync-ipos',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To remove it later:  select cron.unschedule('sync-ipos');
