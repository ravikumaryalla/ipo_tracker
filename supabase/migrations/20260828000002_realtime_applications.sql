-- Let the app subscribe to its own ipo_applications rows over Supabase Realtime.
--
-- The Allotment Status screen reads the v_application_pnl view, but Realtime
-- cannot watch a view, so the client subscribes to this base table and
-- invalidates the ['applications'] query on any change. That covers the case a
-- push cannot: a row resolved by the 15-minute cron sweep, or an outcome
-- recorded on another device, while this device has the app open.
--
-- replica identity full: without it an UPDATE/DELETE change payload omits
-- columns that did not change, so the client-side `user_id=eq.<id>` filter
-- cannot be evaluated for those events. RLS on ipo_applications
-- (auth.uid() = user_id, from 20260809000002_rls.sql) is still enforced for
-- postgres_changes on the authed client — the filter is only belt-and-braces.

alter table public.ipo_applications replica identity full;

-- Idempotent: cron.schedule-style guard so re-applying this file is safe.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ipo_applications'
  ) then
    alter publication supabase_realtime add table public.ipo_applications;
  end if;
end
$$;
