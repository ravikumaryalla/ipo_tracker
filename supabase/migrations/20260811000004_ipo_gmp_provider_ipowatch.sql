-- sync-ipos moved its GMP source from Chittorgarh/InvestorGain to ipowatch.in.
-- Only the default for new rows changes; historical rows keep 'CHITTORGARH' as
-- an accurate record of where that reading actually came from.
alter table public.ipo_gmp alter column provider set default 'IPOWATCH';
