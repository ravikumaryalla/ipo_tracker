-- `registrar` is rendered straight into the IPO screen's "Check allotment at
-- <registrar>" button, so it holds a display name, not a code. It has been
-- holding the code 'KFINTECH' since 20260811000006 set that as the column
-- default, which reads as shouting next to the names the ipogyani sync now
-- writes ('MUFG Intime', 'Bigshare'). Normalise it to the same spelling
-- resolveRegistrar produces.
alter table public.ipos
  alter column registrar set default 'KFintech';

-- created_by is null keeps this to synced rows. A user who typed 'KFINTECH'
-- into the manual-add form meant it, and their row is theirs.
update public.ipos
set registrar = 'KFintech'
where registrar = 'KFINTECH'
  and created_by is null;

-- NOTE: the default itself is left in place on purpose. It is still the right
-- prior for a row nothing else tells us about — most mainboard issues are
-- KFintech — and the ipogyani sync now overwrites it with the truth wherever
-- it has one. What it must no longer do is stay unchallenged: before that
-- sync existed it was applied to every synced IPO, and on the live book it is
-- wrong for 5 of 11 mainboard issues.
