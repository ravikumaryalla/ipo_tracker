/**
 * The dashboard numbers. These are the figures you'd act on, so the edge cases
 * that matter are: nothing applied yet, everything still pending, and a mix of
 * sold and unsold allotments.
 */
import { computeAmounts, summarise } from './applications';
import type { ApplicationPnl, ApplicationStatus } from '../types';

function row(patch: Partial<ApplicationPnl>): ApplicationPnl {
  return {
    id: 'a1',
    user_id: 'u1',
    ipo_id: 'i1',
    demat_account_id: 'acc-1',
    category: 'RETAIL',
    status: 'APPLIED',
    lots: 1,
    bid_price: 100,
    shares_applied: 15,
    amount_blocked: 1500,
    shares_allotted: 0,
    applied_at: '2026-08-01T00:00:00Z',
    sell_price: null,
    sold_at: null,
    allotment_checked_at: null,
    symbol: 'TESTCO',
    company_name: 'Test Co',
    segment: 'MAINBOARD',
    open_date: '2026-08-01',
    close_date: '2026-08-03',
    allotment_date: null,
    listing_date: null,
    listing_price: null,
    current_price: null,
    account_nickname: 'Zerodha',
    amount_invested: 0,
    amount_currently_blocked: 0,
    realised_pnl: 0,
    unrealised_pnl: 0,
    kfintech_company_id: null,
    ...patch,
  };
}

describe('computeAmounts', () => {
  it('multiplies lots by lot size and the bid price', () => {
    expect(computeAmounts({ lots: 2, lot_size: 15, bid_price: 100 })).toEqual({
      shares_applied: 30,
      amount_blocked: 3000,
    });
  });

  it('handles a single lot at a cut-off price', () => {
    expect(computeAmounts({ lots: 1, lot_size: 13, bid_price: 1150 })).toEqual({
      shares_applied: 13,
      amount_blocked: 14950,
    });
  });
});

describe('summarise', () => {
  it('returns zeroes and a null rate when there is nothing to summarise', () => {
    const s = summarise([]);
    expect(s.totalApplications).toBe(0);
    expect(s.amountBlocked).toBe(0);
    expect(s.allotmentRate).toBeNull();
    expect(s.byAccount).toEqual([]);
  });

  it('counts money blocked only for applications still pending', () => {
    const s = summarise([
      row({ status: 'APPLIED', amount_currently_blocked: 1500 }),
      row({ id: 'a2', status: 'NOT_ALLOTTED', amount_currently_blocked: 0 }),
    ]);
    expect(s.amountBlocked).toBe(1500);
    expect(s.liveApplications).toBe(1);
  });

  it('excludes pending applications from the allotment rate', () => {
    // 1 allotted, 1 not allotted, 1 still pending → 50%, not 33%.
    const s = summarise([
      row({ id: 'a1', status: 'ALLOTTED' }),
      row({ id: 'a2', status: 'NOT_ALLOTTED' }),
      row({ id: 'a3', status: 'APPLIED' }),
    ]);
    expect(s.decidedApplications).toBe(2);
    expect(s.allottedApplications).toBe(1);
    expect(s.allotmentRate).toBe(0.5);
  });

  it('counts a partial allotment as an allotment', () => {
    const s = summarise([row({ status: 'PARTIAL' })]);
    expect(s.allotmentRate).toBe(1);
  });

  it('keeps realised and unrealised P&L apart', () => {
    const s = summarise([
      row({ id: 'a1', status: 'ALLOTTED', realised_pnl: 4500, unrealised_pnl: 0 }),
      row({ id: 'a2', status: 'ALLOTTED', realised_pnl: 0, unrealised_pnl: -1200 }),
    ]);
    expect(s.realisedPnl).toBe(4500);
    expect(s.unrealisedPnl).toBe(-1200);
  });

  it('groups by account and sorts the best performer first', () => {
    const s = summarise([
      row({ id: 'a1', demat_account_id: 'acc-1', account_nickname: 'Zerodha', realised_pnl: 500 }),
      row({ id: 'a2', demat_account_id: 'acc-2', account_nickname: 'Groww', realised_pnl: 2000 }),
      row({ id: 'a3', demat_account_id: 'acc-1', account_nickname: 'Zerodha', unrealised_pnl: 300 }),
    ]);

    expect(s.byAccount).toHaveLength(2);
    expect(s.byAccount[0]).toMatchObject({ nickname: 'Groww', applications: 1, pnl: 2000 });
    expect(s.byAccount[1]).toMatchObject({ nickname: 'Zerodha', applications: 2, pnl: 800 });
  });

  it('tolerates numeric columns arriving as strings from PostgREST', () => {
    // Postgres numeric is serialised as a string by PostgREST; the summary must
    // add these up rather than concatenating them.
    const s = summarise([
      row({ realised_pnl: '1500' as unknown as number }),
      row({ id: 'a2', realised_pnl: '2500' as unknown as number }),
    ]);
    expect(s.realisedPnl).toBe(4000);
  });

  it('treats every terminal status as decided', () => {
    const statuses: ApplicationStatus[] = ['ALLOTTED', 'PARTIAL', 'NOT_ALLOTTED', 'REFUNDED'];
    const s = summarise(statuses.map((status, i) => row({ id: `a${i}`, status })));
    expect(s.decidedApplications).toBe(4);
    expect(s.allottedApplications).toBe(2);
  });
});
