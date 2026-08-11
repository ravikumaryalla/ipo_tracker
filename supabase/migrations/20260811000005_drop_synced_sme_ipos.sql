-- sync-ipos no longer tracks SME IPOs (ipowatchIpoRow/ipowatchGmpRow now
-- exclude them at the source). Remove the ones it already synced — but never
-- one a user has actually applied to: ipo_applications.ipo_id cascades on
-- delete, and that data must never be collateral damage in a cleanup like
-- this one. created_by is null further scopes this to synced rows only,
-- never a user's own manually-added SME IPO.
delete from public.ipos
where segment = 'SME'
  and created_by is null
  and not exists (
    select 1 from public.ipo_applications a where a.ipo_id = ipos.id
  );
