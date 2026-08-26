-- One row per IPO's best GMP reading, so the IPO list can show a grey-market
-- premium figure with a single extra query instead of one per row. Provider
-- preference mirrors GMP_PROVIDERS in lib/db/ipos.ts (IPOGYANI over
-- IPOWATCH), so the list agrees with whatever pickGmpProvider would pick on
-- the detail screen.
--
-- security_invoker = on makes the view respect the querying user's RLS
-- policies, same as v_application_pnl (20260809000003_views_and_seed.sql).
-- ipo_gmp already has a public "read all" policy for authenticated users, so
-- this does not widen access.
create view public.v_ipo_latest_gmp
with (security_invoker = on)
as
select distinct on (ipo_id) *
from public.ipo_gmp
where ipo_id is not null
order by ipo_id,
  case provider when 'IPOGYANI' then 0 when 'IPOWATCH' then 1 else 2 end,
  observed_at desc;
