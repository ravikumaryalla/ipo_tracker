/**
 * Fixtures are the real request/response shapes, captured live against
 * https://ipo.bigshareonline.com/Data.aspx/FetchIpodetails on 2026-08-19 —
 * see bigshare.ts's header comment.
 */
import {
  type AllotmentOutcome,
  bigshareStatusFor,
  type BigshareAllotmentMatch,
  parseBigshareAllotmentBody,
} from './bigshare.ts';

describe('parseBigshareAllotmentBody', () => {
  it('maps the live matched response shape', () => {
    const body = {
      d: {
        __type: 'Data+Company',
        APPLICATION_NO: '2608111206508708',
        DPID: '1208940001869634',
        Name: 'MR. EXAMPLE APPLICANT',
        APPLIED: '70',
        ALLOTED: 'NON-ALLOTTE',
        H_APPLICATION_NO: 'Application No',
      },
    };
    expect(parseBigshareAllotmentBody(body)).toEqual({
      applicationNo: '2608111206508708',
      dpClientId: '1208940001869634',
      applicantName: 'MR. EXAMPLE APPLICANT',
      sharesApplied: 70,
      allotedText: 'NON-ALLOTTE',
    });
  });

  it('is null on the live "No data found" no-match shape', () => {
    const body = {
      d: {
        __type: 'Data+Company',
        APPLICATION_NO: '',
        DPID: 'No data found',
        Name: '',
        APPLIED: '',
        ALLOTED: '',
      },
    };
    expect(parseBigshareAllotmentBody(body)).toBeNull();
  });

  it('is null when d is missing or the body is malformed', () => {
    expect(parseBigshareAllotmentBody({})).toBeNull();
    expect(parseBigshareAllotmentBody(null)).toBeNull();
    expect(parseBigshareAllotmentBody({ d: {} })).toBeNull();
  });
});

describe('bigshareStatusFor', () => {
  function match(patch: Partial<BigshareAllotmentMatch> = {}): BigshareAllotmentMatch {
    return {
      applicationNo: 'APP1',
      dpClientId: 'DP1',
      applicantName: 'A NAME',
      sharesApplied: 70,
      allotedText: 'NON-ALLOTTE',
      ...patch,
    };
  }

  it('is NOT_ALLOTTED for the confirmed live "NON-ALLOTTE" text', () => {
    const outcome: AllotmentOutcome = bigshareStatusFor(match().allotedText, 70).status;
    expect(outcome).toBe('NOT_ALLOTTED');
    expect(bigshareStatusFor(match().allotedText, 70).sharesAllotted).toBe(0);
  });

  it('is ALLOTTED for text that reads as allotted without a negation', () => {
    expect(bigshareStatusFor('ALLOTTED', 70)).toEqual({ status: 'ALLOTTED', sharesAllotted: 70 });
  });

  it('is case-insensitive', () => {
    expect(bigshareStatusFor('non-allotte', 70).status).toBe('NOT_ALLOTTED');
  });

  it('treats an unrecognised status as NOT_ALLOTTED rather than guessing', () => {
    expect(bigshareStatusFor('', 70).status).toBe('NOT_ALLOTTED');
    expect(bigshareStatusFor('UNKNOWN', 70).status).toBe('NOT_ALLOTTED');
  });
});
