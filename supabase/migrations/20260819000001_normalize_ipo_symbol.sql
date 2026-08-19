-- Duplicate IPO rows: the sync providers (NSE, BSE, ipowatch, ipogyani) do not
-- all write `symbol` the same way — some trim only, some also uppercase — so
-- the same company can end up under two different-cased symbol strings, which
-- ipos_symbol_open_idx (symbol, open_date) treats as two distinct rows. See
-- supabase/functions/sync-ipos/{index,parse}.ts and ipogyani.ts, now fixed to
-- always uppercase+trim before writing. This migration cleans up rows that
-- already went bad and stops it happening again at the database level.
--
-- Order matters: the existing unique index is on the *unnormalized* symbol, so
-- two rows differing only by case/whitespace can already coexist today.
-- Rewriting the column in place first would immediately violate that index —
-- duplicates must be found and merged using the normalized key before the
-- column itself is normalized.
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
        -- Prefer the row with the most complete data, then the most recently
        -- synced, then the oldest (first-seen) as a final tiebreaker.
        (listing_date is not null) desc,
        (allotment_date is not null) desc,
        (registrar is not null) desc,
        last_synced_at desc nulls last,
        created_at asc
      ) as ids
    from public.ipos
    group by upper(trim(symbol)), open_date
    having count(*) > 1
  loop
    keeper := grp.ids[1];

    for i in 2 .. array_length(grp.ids, 1) loop
      loser := grp.ids[i];

      -- Re-point GMP history onto the surviving row rather than losing it.
      update public.ipo_gmp set ipo_id = keeper where ipo_id = loser;

      -- Re-point applications too. A user could already have one against the
      -- keeper with the same (demat_account_id, category) — the unique
      -- constraint would reject that repoint, so drop the loser's duplicate
      -- application in that case instead of failing the migration; the
      -- keeper's row already represents the same real-world bid.
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

-- Now safe: duplicates that would collide once normalized are gone.
update public.ipos set symbol = upper(trim(symbol)) where symbol <> upper(trim(symbol));

-- Enforce normalization at the database level so no future write path —
-- synced, manual, or one added later — can reintroduce casing/whitespace
-- drift even if application code regresses.
create or replace function public.normalize_ipo_symbol()
returns trigger as $$
begin
  new.symbol := upper(trim(new.symbol));
  return new;
end;
$$ language plpgsql;

create trigger ipos_normalize_symbol
  before insert or update on public.ipos
  for each row execute function public.normalize_ipo_symbol();
