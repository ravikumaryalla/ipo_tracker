-- KFintech allotment-status support.
--
-- KFintech's public allotment-status lookup (https://ipostatus.kfintech.com) is
-- keyed by a per-issue `clientId` the site assigns internally — not by our
-- symbol or ISIN. sync-ipos resolves that id once per issue (public data, no
-- PAN involved) and stores it here so the app can query allotment status
-- on-device without re-discovering the id every time.
--
-- `registrar` / `registrar_url` already existed on `ipos` but were unpopulated
-- by any provider; this is the first writer of both.

alter table public.ipos add column kfintech_company_id text;

comment on column public.ipos.kfintech_company_id is
  'KFintech''s internal clientId for this issue''s allotment-status lookup, when the issue is KFintech-registered and sync-ipos has matched it. Null otherwise.';

-- Sparse: only the (small) subset of rows that are KFintech-registered and
-- matched ever have this set, so a partial index stays cheap and doubles as
-- the "does this IPO support automatic allotment check" test.
create index ipos_kfintech_company_id_idx
  on public.ipos (kfintech_company_id)
  where kfintech_company_id is not null;

-- Extend v_application_pnl so the applications screen can decide whether to
-- show "Check allotment" without a second round trip. CREATE OR REPLACE only
-- allows appending columns, which is exactly what this does — every existing
-- column stays in place.
create or replace view public.v_application_pnl
with (security_invoker = on)
as
select
  a.id,
  a.user_id,
  a.ipo_id,
  a.demat_account_id,
  a.category,
  a.status,
  a.lots,
  a.bid_price,
  a.shares_applied,
  a.amount_blocked,
  a.shares_allotted,
  a.applied_at,
  a.sell_price,
  a.sold_at,
  i.symbol,
  i.company_name,
  i.segment,
  i.open_date,
  i.close_date,
  i.allotment_date,
  i.listing_date,
  i.listing_price,
  i.current_price,
  d.nickname as account_nickname,

  (a.shares_allotted * a.bid_price)::numeric(14,2) as amount_invested,

  case when a.status = 'APPLIED' then a.amount_blocked else 0 end::numeric(14,2)
    as amount_currently_blocked,

  case
    when a.sell_price is not null
      then (a.shares_allotted * (a.sell_price - a.bid_price))
    else 0
  end::numeric(14,2) as realised_pnl,

  case
    when a.sell_price is null and a.shares_allotted > 0
      then (a.shares_allotted * (coalesce(i.current_price, i.listing_price, a.bid_price) - a.bid_price))
    else 0
  end::numeric(14,2) as unrealised_pnl,

  i.kfintech_company_id

from public.ipo_applications a
join public.ipos i on i.id = a.ipo_id
join public.demat_accounts d on d.id = a.demat_account_id;
