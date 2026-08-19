-- Bigshare allotment-status support, mirroring kfintech_company_id
-- (20260811000001_kfintech_allotment.sql).
--
-- Bigshare's public allotment-status lookup (https://ipo.bigshareonline.com)
-- is keyed by a per-issue numeric id its own <select id="ddlCompany"> assigns
-- internally — not our symbol or ISIN. sync-ipos resolves that id (public
-- data, no PAN involved) and stores it here so the app can query allotment
-- status on-device without re-discovering the id every time.
--
-- Unlike kfintech_company_id, this does not need registrar/registrar_url
-- writes alongside it: the ipogyani sync already writes 'Bigshare' there
-- correctly (see ipogyani.ts's REGISTRARS map).

alter table public.ipos add column bigshare_company_id text;

comment on column public.ipos.bigshare_company_id is
  'Bigshare''s internal company id for this issue''s allotment-status lookup, when the issue is Bigshare-registered and sync-ipos has matched it. Null otherwise.';

-- Sparse, same reasoning as ipos_kfintech_company_id_idx: only currently-open
-- Bigshare-registered issues ever have this set.
create index ipos_bigshare_company_id_idx
  on public.ipos (bigshare_company_id)
  where bigshare_company_id is not null;

-- Extend v_application_pnl so the applications screen can decide whether to
-- show an in-app "Check allotment" for a Bigshare-registered issue too,
-- without a second round trip.
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
  i.registrar

from public.ipo_applications a
join public.ipos i on i.id = a.ipo_id
join public.demat_accounts d on d.id = a.demat_account_id;
