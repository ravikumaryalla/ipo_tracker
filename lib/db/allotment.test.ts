/**
 * Tests for the pure decision logic in lib/db/allotment.ts — the boundary
 * function that actually talks to Supabase and KFintech is exercised
 * end-to-end in the app, same as the rest of lib/db (see supabaseMock.ts).
 */
import { pickMatch, statusFor } from './allotment';
import type { KfintechAllotmentMatch } from '../registrars/kfintech';

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
    expect(statusFor(match({ sharesAllotted: 0 }), 100)).toBe('NOT_ALLOTTED');
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
