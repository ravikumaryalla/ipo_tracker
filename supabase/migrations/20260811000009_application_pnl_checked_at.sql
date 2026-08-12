-- Expose allotment_checked_at on v_application_pnl so the app can show "last
-- checked" without a second round trip, including for a check that came back
-- "not announced yet" (status left unchanged, but the timestamp still moves).
--
-- CREATE OR REPLACE only allows appending columns, which is exactly what this
-- does — every existing column stays in place.

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

  i.kfintech_company_id,
  a.allotment_checked_at

from public.ipo_applications a
join public.ipos i on i.id = a.ipo_id
join public.demat_accounts d on d.id = a.demat_account_id;
