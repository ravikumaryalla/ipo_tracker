/**
 * bucketOf decides which tab an IPO shows up under, and it is date arithmetic
 * around inclusive boundaries — exactly the kind of logic that quietly goes
 * wrong on the open and close days themselves.
 */
import { bucketOf, gmpIsStale, gmpTrend, latestGmp, pickGmpProvider } from './ipos';
import type { Ipo, IpoGmp } from '../types';

function ipo(patch: Partial<Ipo>): Ipo {
  return {
    id: 'i1',
    symbol: 'TESTCO',
    company_name: 'Test Co',
    exchange: 'NSE',
    segment: 'MAINBOARD',
    status: 'UPCOMING',
    open_date: null,
    close_date: null,
    allotment_date: null,
    listing_date: null,
    price_band_min: null,
    price_band_max: null,
    lot_size: null,
    issue_size_cr: null,
    listing_price: null,
    current_price: null,
    registrar: null,
    registrar_url: null,
    kfintech_company_id: null,
    bigshare_company_id: null,
    mufg_company_id: null,
    source: 'MANUAL',
    created_by: null,
    last_synced_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...patch,
  };
}

const WINDOW = { open_date: '2026-08-10', close_date: '2026-08-12' };

describe('bucketOf', () => {
  it('is upcoming before the open date', () => {
    expect(bucketOf(ipo(WINDOW), '2026-08-09')).toBe('upcoming');
  });

  it('is open on the open date itself', () => {
    expect(bucketOf(ipo(WINDOW), '2026-08-10')).toBe('open');
  });

  it('is open in the middle of the window', () => {
    expect(bucketOf(ipo(WINDOW), '2026-08-11')).toBe('open');
  });

  it('is still open on the close date — bids are accepted that day', () => {
    expect(bucketOf(ipo(WINDOW), '2026-08-12')).toBe('open');
  });

  it('is closed the day after the close date', () => {
    expect(bucketOf(ipo(WINDOW), '2026-08-13')).toBe('closed');
  });

  it('becomes listed on and after the listing date, overriding closed', () => {
    const withListing = ipo({ ...WINDOW, listing_date: '2026-08-18' });
    expect(bucketOf(withListing, '2026-08-17')).toBe('closed');
    expect(bucketOf(withListing, '2026-08-18')).toBe('listed');
    expect(bucketOf(withListing, '2026-09-01')).toBe('listed');
  });

  it('treats a half-specified window as upcoming rather than guessing', () => {
    expect(bucketOf(ipo({ open_date: '2026-08-10' }), '2026-08-11')).toBe('upcoming');
    expect(bucketOf(ipo({}), '2026-08-11')).toBe('upcoming');
  });
});

/**
 * GMP readings arrive oldest-first from gmpHistory, and a reading with no quote
 * is a null rather than a zero — so both ends of these helpers have to cope with
 * gaps rather than assuming a dense series.
 */
function gmpAt(observed_at: string, gmp: number | null, provider = 'IPOWATCH'): IpoGmp {
  return {
    id: `g-${provider}-${observed_at}`,
    ipo_id: 'i1',
    provider,
    provider_slug: 'test-co-ipo',
    company_name: 'Test Co',
    open_date: '2026-08-10',
    observed_at,
    gmp,
    gmp_percent: null,
    price: 100,
    sub_times: null,
    source_url: null,
    synced_at: observed_at,
    created_at: observed_at,
  };
}

describe('latestGmp', () => {
  it('takes the last reading, since the series arrives oldest-first', () => {
    const rows = [gmpAt('2026-08-09T10:00:00Z', 5), gmpAt('2026-08-10T10:00:00Z', 9)];
    expect(latestGmp(rows)?.gmp).toBe(9);
  });

  it('is null for an empty series', () => {
    expect(latestGmp([])).toBeNull();
  });
});

describe('gmpTrend', () => {
  const earlier = gmpAt('2026-08-09T10:00:00Z', 5);

  it('reports direction between the two most recent quotes', () => {
    expect(gmpTrend([earlier, gmpAt('2026-08-10T10:00:00Z', 9)])).toBe('up');
    expect(gmpTrend([earlier, gmpAt('2026-08-10T10:00:00Z', 2)])).toBe('down');
    expect(gmpTrend([earlier, gmpAt('2026-08-10T10:00:00Z', 5)])).toBe('flat');
  });

  it('ignores unquoted readings rather than treating them as zero', () => {
    const rows = [earlier, gmpAt('2026-08-10T06:00:00Z', null), gmpAt('2026-08-10T10:00:00Z', 9)];
    expect(gmpTrend(rows)).toBe('up');
  });

  it('is unknown until there are two quotes to compare', () => {
    expect(gmpTrend([])).toBe('unknown');
    expect(gmpTrend([earlier])).toBe('unknown');
    expect(gmpTrend([gmpAt('2026-08-10T10:00:00Z', null)])).toBe('unknown');
  });
});

/**
 * Two providers write readings for the same IPO and they quote different desks
 * at different times. Mixing them draws one line zig-zagging between two
 * series, which `gmpTrend` would then report as movement in the market.
 */
describe('pickGmpProvider', () => {
  const ipowatch = gmpAt('2026-08-10T10:00:00Z', 5, 'IPOWATCH');
  const ipogyani = gmpAt('2026-08-10T11:00:00Z', 9, 'IPOGYANI');

  it('prefers ipogyani when both feeds have readings', () => {
    expect(pickGmpProvider([ipogyani, ipowatch])).toEqual([ipogyani]);
  });

  it('falls back to ipowatch when ipogyani has nothing', () => {
    expect(pickGmpProvider([ipowatch])).toEqual([ipowatch]);
  });

  it('keeps an unrecognised provider rather than showing an empty chart', () => {
    const other = gmpAt('2026-08-10T09:00:00Z', 3, 'CHITTORGARH');
    expect(pickGmpProvider([other])).toEqual([other]);
  });

  it('never mixes providers, even an unrecognised one', () => {
    const other = gmpAt('2026-08-10T09:00:00Z', 3, 'CHITTORGARH');
    const another = gmpAt('2026-08-10T08:00:00Z', 4, 'INVESTORGAIN');
    expect(pickGmpProvider([other, another])).toEqual([other]);
  });

  it('is empty for an empty series', () => {
    expect(pickGmpProvider([])).toEqual([]);
  });
});

describe('gmpIsStale', () => {
  const rows = [gmpAt('2026-08-10T00:00:00Z', 5)];

  it('is fresh within the window', () => {
    expect(gmpIsStale(rows, new Date('2026-08-10T12:00:00Z'))).toBe(false);
  });

  it('goes stale after a day — grey market quotes move fast', () => {
    expect(gmpIsStale(rows, new Date('2026-08-11T06:00:00Z'))).toBe(true);
  });

  it('treats no readings at all as stale', () => {
    expect(gmpIsStale([], new Date('2026-08-10T12:00:00Z'))).toBe(true);
  });
});
