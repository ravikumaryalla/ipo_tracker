-- Move the cron trigger off app.settings.* and onto Supabase Vault.
--
-- 20260810000002_cron.sql assumed `alter database postgres set app.settings.x`
-- would work as a superuser. On Supabase-hosted projects it does not: the
-- `postgres` role handed out in the SQL editor is not a real Postgres
-- superuser, and setting a custom GUC class requires one
-- ("permission denied to set parameter"). That was a wrong assumption from
-- day one, not a regression — this migration replaces it with the mechanism
-- Supabase actually supports for this.
--
-- The service-role key now lives in Supabase Vault, encrypted at rest and
-- readable only through `vault.decrypted_secrets`, which itself is only
-- queryable by roles with table-level access (postgres / service_role) —
-- not by `anon` or `authenticated`. The project URL is not a secret, so it's
-- inlined directly rather than round-tripped through Vault for no reason.
--
-- This migration does NOT create the secret itself — a value like that has no
-- business sitting in a migration file that ends up in git history. Run this
-- once, by hand, in the SQL editor, as a superuser:
--
--   select vault.create_secret('YOUR-SERVICE-ROLE-KEY', 'service_role_key');
--
-- (To rotate it later: select vault.update_secret(id, 'NEW-KEY') where name = 'service_role_key'.)

create or replace function public.trigger_sync_ipos()
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
    url     := base || '/functions/v1/sync-ipos',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || key
    ),
    body    := '{}'::jsonb
  );
end;
$$;

revoke all on function public.trigger_sync_ipos() from public;
revoke all on function public.trigger_sync_ipos() from anon, authenticated;
