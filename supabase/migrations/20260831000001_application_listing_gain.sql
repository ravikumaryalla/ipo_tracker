-- Per-allotment "listing gain": the rupee amount the user booked (or lost) when
-- an allotted issue listed, entered and updated by hand.
--
-- Nullable on purpose: null means "not recorded yet", which is a different
-- statement from 0 (a flat listing). Negative is a listing loss.
--
-- Deliberately NOT derived from ipos.listing_price / current_price. Those are
-- best-effort synced market data; this is the figure the user actually took
-- home (their real sale price, net of costs) or chooses to track. It is kept
-- separate from the view-computed realised_pnl / unrealised_pnl and is only
-- ever surfaced labelled as user-entered.

alter table public.ipo_applications
  add column if not exists listing_gain numeric(14,2);

comment on column public.ipo_applications.listing_gain is
  'User-entered rupee gain/loss booked on this allotment. Null = not recorded; negative = listing loss. Not computed from market data.';

-- Append-only re-emit, same rule as every prior extension of this view
-- (20260819000005_mufg_allotment.sql was the last): existing column order is
-- unchanged; listing_gain is added last. CREATE OR REPLACE only allows appends.
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
  a.allotment_checked_at,
  i.bigshare_company_id,
  i.registrar,
  i.mufg_company_id,
  a.listing_gain

from public.ipo_applications a
join public.ipos i on i.id = a.ipo_id
join public.demat_accounts d on d.id = a.demat_account_id;
