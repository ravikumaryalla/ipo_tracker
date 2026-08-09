-- Grey market premium history.
--
-- GMP is an unregulated, unofficial number quoted by grey-market dealers. It is
-- not exchange data, SEBI has publicly cautioned retail investors against
-- relying on it, and on thinly-traded SME issues it is manipulable. Anything
-- rendering it must say so.
--
-- It is stored as a time series, never as a column on `ipos`, for two reasons:
-- a single reading is close to meaningless (the trend before the issue closes
-- is the signal), and overwriting would destroy the only record of what the
-- market thought at the time.

create table public.ipo_gmp (
  id            uuid primary key default gen_random_uuid(),

  -- Nullable on purpose. Chittorgarh often quotes a grey market before NSE or
  -- BSE publish the issue, and a reading we cannot attach yet is still worth
  -- keeping: the backfill pass in sync-ipos re-tries these every run, so the
  -- chart is complete from day one once the IPO itself lands.
  ipo_id        uuid references public.ipos(id) on delete cascade,

  -- Provenance, and the fallback join key while ipo_id is null.
  provider      text not null default 'CHITTORGARH',
  provider_slug text not null,          -- 'qt-foods-ipo'
  company_name  text not null,          -- as the provider spells it
  open_date     date,                   -- the provider's own issue open date

  -- The reading itself. `observed_at` is the provider's "last updated" stamp,
  -- NOT our fetch time — two syncs can see the same reading, and that must not
  -- put two points on the chart.
  observed_at   timestamptz not null,
  gmp           numeric(12,2),          -- premium in rupees; null = no quote
  gmp_percent   numeric(6,2),           -- against `price`
  price         numeric(12,2),          -- cap price the percent is computed on
  sub_times     numeric(10,2),          -- subscription multiple, when quoted
  source_url    text,

  synced_at     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

comment on table public.ipo_gmp is
  'Append-only grey market premium readings. Unofficial data — display with a disclaimer.';

-- Idempotency: re-running a sync inside one provider update window is a no-op
-- rather than a duplicate point.
create unique index ipo_gmp_reading_idx
  on public.ipo_gmp (provider, provider_slug, observed_at);

-- The charting query: newest N readings for one IPO.
create index ipo_gmp_ipo_idx
  on public.ipo_gmp (ipo_id, observed_at desc);

-- The backfill query: readings still waiting for an `ipos` row.
create index ipo_gmp_unmatched_idx
  on public.ipo_gmp (open_date, provider_slug)
  where ipo_id is null;

-- No updated_at and no touch trigger: this table is append-only, like
-- credential_history.

alter table public.ipo_gmp enable row level security;

-- Same posture as brokers and sync_log: public market data, readable by any
-- signed-in user, written only by the service role (which bypasses RLS). Rows
-- only ever reference synced IPOs, which every user can already read.
create policy "gmp: read all" on public.ipo_gmp
  for select to authenticated using (true);
