-- P&L view + broker seed data.

-- ---------------------------------------------------------------------------
-- v_application_pnl: per-application economics, computed in Postgres so the
-- dashboard is one query instead of client-side math over every row.
--
-- security_invoker = on makes the view respect the querying user's RLS
-- policies. Without it the view would run as its owner and leak other users'
-- applications — this flag is load-bearing, do not remove it.
-- ---------------------------------------------------------------------------
create view public.v_application_pnl
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

  -- What the allotment actually cost.
  (a.shares_allotted * a.bid_price)::numeric(14,2) as amount_invested,

  -- Money still with the registrar: blocked while the bid is live, released
  -- once the outcome is known.
  case when a.status = 'APPLIED' then a.amount_blocked else 0 end::numeric(14,2)
    as amount_currently_blocked,

  -- Realised P&L once sold; otherwise unrealised against the best price we know
  -- (live price if we have it, else the listing price).
  case
    when a.sell_price is not null
      then (a.shares_allotted * (a.sell_price - a.bid_price))
    else 0
  end::numeric(14,2) as realised_pnl,

  case
    when a.sell_price is null and a.shares_allotted > 0
      then (a.shares_allotted * (coalesce(i.current_price, i.listing_price, a.bid_price) - a.bid_price))
    else 0
  end::numeric(14,2) as unrealised_pnl

from public.ipo_applications a
join public.ipos i on i.id = a.ipo_id
join public.demat_accounts d on d.id = a.demat_account_id;

-- ---------------------------------------------------------------------------
-- Indian brokers, seeded once. Idempotent so re-running migrations is safe.
-- ---------------------------------------------------------------------------
insert into public.brokers (name, slug, website) values
  ('Zerodha',            'zerodha',      'https://zerodha.com'),
  ('Groww',              'groww',        'https://groww.in'),
  ('Upstox',             'upstox',       'https://upstox.com'),
  ('Angel One',          'angel-one',    'https://angelone.in'),
  ('ICICI Direct',       'icici-direct', 'https://icicidirect.com'),
  ('HDFC Securities',    'hdfc-sec',     'https://hdfcsec.com'),
  ('Kotak Securities',   'kotak-sec',    'https://kotaksecurities.com'),
  ('5paisa',             '5paisa',       'https://5paisa.com'),
  ('Motilal Oswal',      'motilal',      'https://motilaloswal.com'),
  ('Sharekhan',          'sharekhan',    'https://sharekhan.com'),
  ('SBI Securities',     'sbi-sec',      'https://sbisecurities.in'),
  ('Axis Direct',        'axis-direct',  'https://axisdirect.in'),
  ('Dhan',               'dhan',         'https://dhan.co'),
  ('Fyers',              'fyers',        'https://fyers.in'),
  ('Paytm Money',        'paytm-money',  'https://paytmmoney.com'),
  ('IIFL Securities',    'iifl',         'https://iiflcapital.com'),
  ('Other',              'other',        null)
on conflict (slug) do nothing;
