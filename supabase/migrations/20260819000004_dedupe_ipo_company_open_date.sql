-- Merges ipos rows that are the same company/issue but ended up under
-- different symbols — the residual risk flagged (but left unfixed) in
-- 20260819000001_normalize_ipo_symbol.sql: that migration only fixed
-- casing/whitespace drift on an otherwise-identical symbol, keyed by
-- (symbol, open_date). It could not catch two genuinely different symbol
-- strings for the same company (e.g. a slug wording change between sync
-- runs producing "SUNSHINE" one day and "SUNSHINEPICTURES" the next), since
-- those never collide on ipos_symbol_open_idx in the first place.
--
-- Found live via (company_name, open_date) grouping: 14 duplicate groups,
-- some with 3 rows (Behari Lal Engineering, Horizon Industrial Parks),
-- several with real ipo_applications/ipo_gmp rows attached to the row being
-- removed — so this uses the same safe merge as that earlier migration:
-- carry forward any field the surviving row is missing from the one being
-- removed, re-point ipo_gmp and ipo_applications onto the survivor first
-- (dropping a losing application only when the survivor already has an
-- identical one, to satisfy ipo_applications_unique_bid), then delete.
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
        -- Prefer the row with the most complete data, then the most
        -- recently synced, then the oldest (first-seen) as a final
        -- tiebreaker — same ordering as the earlier symbol-merge migration.
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

      -- A field the survivor lacks but the row being removed has is real
      -- information (a registrar match, a price) and must not be silently
      -- dropped just because it happened to sync less recently overall.
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
