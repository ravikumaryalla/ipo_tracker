/**
 * Fixtures are the real response shapes, captured live against
 * https://in.mpms.mufg.com/Initial_Offer/IPO.aspx/SearchOnPan on 2026-08-19 —
 * see mufg.ts's header comment.
 */
import {
  type AllotmentOutcome,
  encryptMufgToken,
  mufgStatusFor,
  type MufgAllotmentMatch,
  parseMufgAllotmentBody,
} from './mufg.ts';

describe('parseMufgAllotmentBody', () => {
  it('maps the live matched response shape', () => {
    const body = {
      d:
        '<NewDataSet>\r\n  <Table>\r\n    <id>11922</id>\r\n    <offer_price>285</offer_price>\r\n    ' +
        '<pull>X</pull>\r\n    <DPCLITID>1208940001869634</DPCLITID>\r\n    <RFNDNO>6033440</RFNDNO>\r\n    ' +
        '<RFNDAMT>14820</RFNDAMT>\r\n    <NAME1>MR EXAMPLE APPLICANT</NAME1>\r\n    ' +
        '<companyname>Behari Lal Engineering Limited - IPO</companyname>\r\n    <ALLOT>0</ALLOT>\r\n    ' +
        '<SHARES>52</SHARES>\r\n    <AMTADJ>0</AMTADJ>\r\n    <PEMNDG>Retail</PEMNDG>\r\n    ' +
        '<BNKCODE>702</BNKCODE>\r\n  </Table>\r\n</NewDataSet>',
    };
    expect(parseMufgAllotmentBody(body)).toEqual({
      dpClientId: '1208940001869634',
      applicantName: 'MR EXAMPLE APPLICANT',
      sharesApplied: 52,
      sharesAllotted: 0,
    });
  });

  it('is null on the Table1/Msg no-match shape', () => {
    const body = { d: '<NewDataSet><Table1><Msg>No Record Found</Msg></Table1></NewDataSet>' };
    expect(parseMufgAllotmentBody(body)).toBeNull();
  });

  it('is null when d is missing, empty, or unparseable', () => {
    expect(parseMufgAllotmentBody({})).toBeNull();
    expect(parseMufgAllotmentBody(null)).toBeNull();
    expect(parseMufgAllotmentBody({ d: '' })).toBeNull();
    expect(parseMufgAllotmentBody({ d: '<NewDataSet></NewDataSet>' })).toBeNull();
  });
});

describe('mufgStatusFor', () => {
  function match(patch: Partial<MufgAllotmentMatch> = {}): MufgAllotmentMatch {
    return {
      dpClientId: 'DP1',
      applicantName: 'A NAME',
      sharesApplied: 100,
      sharesAllotted: 0,
      ...patch,
    };
  }

  it('is NOT_ALLOTTED when nothing was allotted', () => {
    const outcome: AllotmentOutcome = mufgStatusFor(match({ sharesAllotted: 0 }), 100);
    expect(outcome).toBe('NOT_ALLOTTED');
  });

  it('is ALLOTTED when the full applied quantity came through', () => {
    expect(mufgStatusFor(match({ sharesApplied: 100, sharesAllotted: 100 }), 100)).toBe('ALLOTTED');
  });

  it('is PARTIAL when fewer shares were allotted than applied', () => {
    expect(mufgStatusFor(match({ sharesApplied: 100, sharesAllotted: 40 }), 100)).toBe('PARTIAL');
  });

  it("falls back to the application record's shares_applied when MUFG omits it", () => {
    expect(mufgStatusFor(match({ sharesApplied: null, sharesAllotted: 100 }), 100)).toBe('ALLOTTED');
    expect(mufgStatusFor(match({ sharesApplied: null, sharesAllotted: 40 }), 100)).toBe('PARTIAL');
  });
});

describe('encryptMufgToken', () => {
  it('produces a base64 string', async () => {
    const encrypted = await encryptMufgToken('some-raw-token');
    expect(typeof encrypted).toBe('string');
    expect(encrypted.length).toBeGreaterThan(0);
    expect(() => atob(encrypted)).not.toThrow();
  });

  it('is deterministic for a fixed key/IV, so a re-encrypt of the same token matches', async () => {
    const a = await encryptMufgToken('abc123');
    const b = await encryptMufgToken('abc123');
    expect(a).toBe(b);
  });

  it('differs for a different token', async () => {
    const a = await encryptMufgToken('abc123');
    const b = await encryptMufgToken('xyz789');
    expect(a).not.toBe(b);
  });
});
