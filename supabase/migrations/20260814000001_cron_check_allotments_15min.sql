-- Supersedes the hourly job created in 20260811000008_cron_check_allotments.sql.
--
-- Every 15 minutes instead of hourly, because the allotment result is worth
-- knowing the moment it lands, not up to an hour later. The tighter cadence is
-- affordable because check-allotments gates on isAllotmentCheckDue(), which is
-- now a single three-hour window (21:00 IST to midnight on allotment_date):
-- outside it every tick costs one indexed query over unresolved applications
-- and stops, and KFintech is never touched.
--
-- trigger_check_allotments() is unchanged and reused as-is.

-- Idempotent: the guard makes re-applying this file safe, and cron.schedule()
-- upserts by jobname — same pattern as 20260810000002_cron.sql.
select cron.unschedule('check-allotments-hourly')
where exists (select 1 from cron.job where jobname = 'check-allotments-hourly');

select cron.schedule('check-allotments-15min', '*/15 * * * *',
                     $$ select public.trigger_check_allotments(); $$);
