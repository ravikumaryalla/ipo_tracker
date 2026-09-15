/**
 * pickMatch/statusFor mirror lib/db/allotment.ts exactly (see parse.ts's
 * header comment for why this is a copy, not an import) — these tests are
 * the same claims, ported alongside the code.
 */
import {
  type AllotmentOutcome,
  allotmentCheckIntervalMs,
  isAllotmentCheckDue,
  type KfintechAllotmentMatch,
  parseKfintechAllotmentBody,
  pickMatch,
  statusFor,
} from './parse.ts';

function match(patch: Partial<KfintechAllotmentMatch> = {}): KfintechAllotmentMatch {
  return {
    applicationNo: 'APP1',
    dpClientId: 'DP1',
    applicantName: 'A NAME',
    sharesApplied: 100,
    sharesAllotted: 0,
    ...patch,
  };
}

/**
 * All times below are for allotment_date 2026-08-17, where the window runs
 * 21:00 IST on the 17th (15:30 UTC) to 08:00 IST on the 18th (02:30 UTC),
 * and the 2-minute phase gives way to the 5-minute one at midnight IST
 * (18:30 UTC on the 17th).
 */
const DATE = '2026-08-17';

/** An ISO stamp `seconds` before `nowIso`, for the cadence cases. */
function ago(nowIso: string, seconds: number): string {
  return new Date(new Date(nowIso).getTime() - seconds * 1000).toISOString();
}

describe('isAllotmentCheckDue: the window', () => {
  it('is not due before 21:00 IST on allotment_date', () => {
    // 20:59 IST = 15:29 UTC.
    expect(isAllotmentCheckDue(DATE, '2026-08-17T15:29:00.000Z')).toBe(false);
  });

  it('is due at exactly 21:00 IST on allotment_date', () => {
    // 21:00 IST = 15:30 UTC.
    expect(isAllotmentCheckDue(DATE, '2026-08-17T15:30:00.000Z')).toBe(true);
  });

  it('stays due later the same evening', () => {
    // 23:50 IST = 18:20 UTC.
    expect(isAllotmentCheckDue(DATE, '2026-08-17T18:20:00.000Z')).toBe(true);
  });

  it('stays open through midnight IST — the old window closed here', () => {
    // 00:00 IST on the 18th = 18:30 UTC on the 17th. Now a phase boundary
    // between the 2- and 5-minute cadences, not the end of the sweep.
    expect(isAllotmentCheckDue(DATE, '2026-08-17T18:30:00.000Z')).toBe(true);
  });

  it('is still due at 07:59 IST the next morning', () => {
    // 07:59 IST on the 18th = 02:29 UTC on the 18th.
    expect(isAllotmentCheckDue(DATE, '2026-08-18T02:29:00.000Z')).toBe(true);
  });

  it('closes at 08:00 IST the next morning', () => {
    // 08:00 IST on the 18th = 02:30 UTC on the 18th.
    expect(isAllotmentCheckDue(DATE, '2026-08-18T02:30:00.000Z')).toBe(false);
  });

  it('does not reopen on a later day, even if still unresolved', () => {
    expect(isAllotmentCheckDue(DATE, '2026-08-19T04:00:00.000Z')).toBe(false);
  });

  it('is false for an unparseable date', () => {
    expect(isAllotmentCheckDue('soon', '2026-08-17T18:00:00.000Z')).toBe(false);
  });
});

describe('isAllotmentCheckDue: the cadence', () => {
  // 21:30 IST on the 17th — inside the 2-minute phase.
  const EVENING = '2026-08-17T16:00:00.000Z';
  // 01:30 IST on the 18th — inside the 5-minute phase.
  const OVERNIGHT = '2026-08-17T20:00:00.000Z';

  it('is due when the row has never been checked', () => {
    expect(isAllotmentCheckDue(DATE, EVENING, null)).toBe(true);
    expect(isAllotmentCheckDue(DATE, EVENING, undefined)).toBe(true);
  });

  it('treats an unreadable stamp as never checked', () => {
    expect(isAllotmentCheckDue(DATE, EVENING, 'whenever')).toBe(true);
  });

  it('is not due a minute after a check, before midnight', () => {
    expect(isAllotmentCheckDue(DATE, EVENING, ago(EVENING, 60))).toBe(false);
  });

  it('is due two minutes after a check, before midnight', () => {
    expect(isAllotmentCheckDue(DATE, EVENING, ago(EVENING, 120))).toBe(true);
  });

  it('is due at 113s — a sweep stamps seconds after the tick that started it', () => {
    // The tolerance case, and the one that regresses silently: without slack
    // the measured gap falls just short and every interval stretches by a
    // whole tick, turning 2 minutes into 3.
    expect(isAllotmentCheckDue(DATE, EVENING, ago(EVENING, 113))).toBe(true);
  });

  it('is not due three minutes after a check, past midnight', () => {
    expect(isAllotmentCheckDue(DATE, OVERNIGHT, ago(OVERNIGHT, 180))).toBe(false);
  });

  it('is not due four minutes after a check, past midnight', () => {
    // Proves the overnight phase really is 5 minutes and not still 2.
    expect(isAllotmentCheckDue(DATE, OVERNIGHT, ago(OVERNIGHT, 240))).toBe(false);
  });

  it('is due five minutes after a check, past midnight', () => {
    expect(isAllotmentCheckDue(DATE, OVERNIGHT, ago(OVERNIGHT, 300))).toBe(true);
  });

  it('respects the cadence even when the stamp came from an on-demand tap', () => {
    // allotment_checked_at is stamped by the "Check status" button too, so a
    // tap correctly defers the next scheduled check rather than being ignored.
    expect(isAllotmentCheckDue(DATE, EVENING, ago(EVENING, 30))).toBe(false);
  });
});

describe('allotmentCheckIntervalMs', () => {
  it('is two minutes from 21:00 IST until midnight', () => {
    expect(allotmentCheckIntervalMs(DATE, '2026-08-17T15:30:00.000Z')).toBe(2 * 60_000);
    expect(allotmentCheckIntervalMs(DATE, '2026-08-17T18:29:59.000Z')).toBe(2 * 60_000);
  });

  it('is five minutes from midnight IST until 08:00', () => {
    expect(allotmentCheckIntervalMs(DATE, '2026-08-17T18:30:00.000Z')).toBe(5 * 60_000);
    expect(allotmentCheckIntervalMs(DATE, '2026-08-18T02:29:00.000Z')).toBe(5 * 60_000);
  });

  it('is null outside the window', () => {
    expect(allotmentCheckIntervalMs(DATE, '2026-08-17T15:29:00.000Z')).toBeNull();
    expect(allotmentCheckIntervalMs(DATE, '2026-08-18T02:30:00.000Z')).toBeNull();
  });

  it('is null for an unparseable date', () => {
    expect(allotmentCheckIntervalMs('soon', '2026-08-17T16:00:00.000Z')).toBeNull();
  });
});

describe('parseKfintechAllotmentBody', () => {
  it('maps the live response shape', () => {
    const body = {
      data: [
        { Appln_No: '123', DP_CLID: 'IN300394', Name: 'RAVI', App_Shares: '52', All_Shares: '52' },
      ],
    };
    expect(parseKfintechAllotmentBody(body)).toEqual([
      {
        applicationNo: '123',
        dpClientId: 'IN300394',
        applicantName: 'RAVI',
        sharesApplied: 52,
        sharesAllotted: 52,
      },
    ]);
  });

  it('treats a missing All_Shares as zero, not null — KFintech omits it for a clean non-allotment', () => {
    const body = { data: [{ Appln_No: '123' }] };
    expect(parseKfintechAllotmentBody(body)?.[0].sharesAllotted).toBe(0);
  });

  it('is null when there is nothing on file yet', () => {
    expect(parseKfintechAllotmentBody({ data: [] })).toBeNull();
    expect(parseKfintechAllotmentBody(null)).toBeNull();
    expect(parseKfintechAllotmentBody({})).toBeNull();
  });
});

describe('pickMatch', () => {
  it('returns the only match without needing an application number', () => {
    const only = match();
    expect(pickMatch([only], null)).toBe(only);
  });

  it('picks the match whose application number matches ours', () => {
    const a = match({ applicationNo: 'APP1' });
    const b = match({ applicationNo: 'APP2' });
    expect(pickMatch([a, b], 'APP2')).toBe(b);
  });

  it('refuses to guess between several matches when we have no application number on file', () => {
    const a = match({ applicationNo: 'APP1' });
    const b = match({ applicationNo: 'APP2' });
    expect(() => pickMatch([a, b], null)).toThrow(/more than one application/i);
  });

  it('refuses to guess when our application number matches none of them', () => {
    const a = match({ applicationNo: 'APP1' });
    const b = match({ applicationNo: 'APP2' });
    expect(() => pickMatch([a, b], 'APP3')).toThrow(/more than one application/i);
  });
});

describe('statusFor', () => {
  it('is NOT_ALLOTTED when nothing was allotted', () => {
    const outcome: AllotmentOutcome = statusFor(match({ sharesAllotted: 0 }), 100);
    expect(outcome).toBe('NOT_ALLOTTED');
  });

  it('is ALLOTTED when the full applied quantity came through', () => {
    expect(statusFor(match({ sharesApplied: 100, sharesAllotted: 100 }), 100)).toBe('ALLOTTED');
  });

  it('is PARTIAL when fewer shares were allotted than applied', () => {
    expect(statusFor(match({ sharesApplied: 100, sharesAllotted: 40 }), 100)).toBe('PARTIAL');
  });

  it('falls back to the application record\'s shares_applied when KFintech omits it', () => {
    expect(statusFor(match({ sharesApplied: null, sharesAllotted: 100 }), 100)).toBe('ALLOTTED');
    expect(statusFor(match({ sharesApplied: null, sharesAllotted: 40 }), 100)).toBe('PARTIAL');
  });
});
