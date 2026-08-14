/**
 * The dashboard numbers. These are the figures you'd act on, so the edge cases
 * that matter are: nothing applied yet, everything still pending, and a mix of
 * sold and unsold allotments.
 */
import {
  computeAmounts,
  summarise,
  touchAllotmentChecked,
  updateApplicationOutcome,
} from './applications';
import { clearSupabaseStub, setSupabaseStub } from '../testing/supabaseMock';
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

/**
 * "Last checked" is the only signal the user has that a registrar lookup
 * actually happened, so which writer stamps allotment_checked_at is the whole
 * point: updateApplicationOutcome used to stamp it too, which meant typing a
 * result in by hand claimed a check that never ran.
 */
describe('allotment_checked_at writers', () => {
  type Update = { table: string; payload: Record<string, unknown>; filter: [string, string, unknown] };

  function recordUpdates(result: unknown = { data: {}, error: null }) {
    const updates: Update[] = [];
    setSupabaseStub({
      from: (table: string) => ({
        update: (payload: Record<string, unknown>) => {
          const capture = (op: string, column: string, value: unknown) => {
            updates.push({ table, payload, filter: [op, column, value] });
            return builder;
          };
          const builder = {
            eq: (c: string, v: unknown) => capture('eq', c, v),
            in: (c: string, v: unknown) => capture('in', c, v),
            select: () => builder,
            single: async () => result,
            then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              Promise.resolve(result).then(onOk, onErr),
          };
          return builder;
        },
      }),
    });
    return updates;
  }

  afterEach(clearSupabaseStub);

  it('does not stamp allotment_checked_at when an outcome is saved by hand', async () => {
    const updates = recordUpdates({ data: row({ status: 'ALLOTTED' }), error: null });

    await updateApplicationOutcome('a1', { status: 'ALLOTTED', shares_allotted: 15 });

    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ status: 'ALLOTTED', shares_allotted: 15 });
    expect(updates[0].payload).not.toHaveProperty('allotment_checked_at');
    expect(updates[0].filter).toEqual(['eq', 'id', 'a1']);
  });

  it('stamps allotment_checked_at for every id in one request, touching nothing else', async () => {
    const updates = recordUpdates({ error: null });

    await touchAllotmentChecked(['a1', 'a2', 'a3']);

    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].payload)).toEqual(['allotment_checked_at']);
    expect(Date.parse(updates[0].payload.allotment_checked_at as string)).not.toBeNaN();
    expect(updates[0].filter).toEqual(['in', 'id', ['a1', 'a2', 'a3']]);
  });

  it('makes no request when there is nothing to stamp', async () => {
    const updates = recordUpdates({ error: null });

    await touchAllotmentChecked([]);

    expect(updates).toHaveLength(0);
  });
});
