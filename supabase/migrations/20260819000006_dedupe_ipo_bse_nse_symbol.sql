-- Merges ipos rows that are the same company/issue but ended up under two
-- different symbols because the BSE provider used to write its own scrip
-- code instead of reusing the NSE symbol already chosen for the same
-- company/open_date (fetchBse in sync-ipos/index.ts). ipowatch's own
-- listing-table BSE fallback (parse.ts's ipowatchIpoRow) could do the same.
-- Both are now fixed to prefer the NSE symbol, so this is a one-time backfill
-- for rows that already diverged, using the same safe merge as the two prior
-- dedupe migrations (20260819000001, 20260819000004): carry forward any
-- field the surviving row is missing, re-point ipo_gmp/ipo_applications onto
-- the survivor, then delete the loser. The keeper is chosen to prefer the
-- NSE-sourced row first, ahead of the completeness tiebreakers those
-- migrations used.
do $$
declare
  grp record;
  keeper uuid;
  loser uuid;
  i int;
begin
  for grp in
    select
      array_agg(id order by
        (exchange = 'NSE') desc,
        (listing_date is not null) desc,
        (allotment_date is not null) desc,
        (registrar is not null) desc,
        last_synced_at desc nulls last,
        created_at asc
      ) as ids
    from public.ipos
    group by company_name, open_date
    having count(*) > 1
  loop
    keeper := grp.ids[1];

    for i in 2 .. array_length(grp.ids, 1) loop
      loser := grp.ids[i];

      update public.ipos k
      set
        registrar = coalesce(k.registrar, l.registrar),
        registrar_url = coalesce(k.registrar_url, l.registrar_url),
        kfintech_company_id = coalesce(k.kfintech_company_id, l.kfintech_company_id),
        bigshare_company_id = coalesce(k.bigshare_company_id, l.bigshare_company_id),
        listing_price = coalesce(k.listing_price, l.listing_price),
        current_price = coalesce(k.current_price, l.current_price),
        lot_size = coalesce(k.lot_size, l.lot_size),
        issue_size_cr = coalesce(k.issue_size_cr, l.issue_size_cr)
      from public.ipos l
      where k.id = keeper and l.id = loser;

      update public.ipo_gmp set ipo_id = keeper where ipo_id = loser;

      delete from public.ipo_applications a
      where a.ipo_id = loser
        and exists (
          select 1 from public.ipo_applications k
          where k.ipo_id = keeper
            and k.demat_account_id = a.demat_account_id
            and k.category = a.category
        );
      update public.ipo_applications set ipo_id = keeper where ipo_id = loser;

      delete from public.ipos where id = loser;
    end loop;
  end loop;
end $$;
