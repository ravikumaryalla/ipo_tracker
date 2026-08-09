/**
 * bucketOf decides which tab an IPO shows up under, and it is date arithmetic
 * around inclusive boundaries — exactly the kind of logic that quietly goes
 * wrong on the open and close days themselves.
 */
import { bucketOf } from './ipos';
import type { Ipo } from '../types';

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
