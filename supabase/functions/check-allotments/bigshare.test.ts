/**
 * Fixtures are the real request/response shapes, captured live against
 * https://ipo.bigshareonline.com/Data.aspx/FetchIpodetails on 2026-08-19 —
 * see bigshare.ts's header comment.
 */
import {
  type AllotmentOutcome,
  BIGSHARE_BLOCK_TRIP_AFTER,
  BIGSHARE_CAPTCHA_UNREAD_MESSAGE,
  BIGSHARE_MIN_REQUEST_GAP_MS,
  bigshareRunDeadlineExceeded,
  bigshareStatusFor,
  bigshareUnavailableMessage,
  bigshareWaitMs,
  type BigshareAllotmentMatch,
  isRetryableCaptchaStatus,
  parseBigshareAllotmentBody,
  parseCaptchaChallenge,
  parseOcrAnswer,
  shouldStopTryingBigshare,
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

describe('bigshareUnavailableMessage', () => {
  it('is null on a normal matched (Status: OK) response', () => {
    const body = { d: { Status: 'OK', DPID: '1208940001869634' } };
    expect(bigshareUnavailableMessage(body)).toBeNull();
  });

  it('is null on a normal no-match (Status: NOTFOUND) response', () => {
    const body = { d: { Status: 'NOTFOUND', DPID: 'No data found' } };
    expect(bigshareUnavailableMessage(body)).toBeNull();
  });

  it('is null when Status is absent, same as older/pre-captcha responses', () => {
    expect(bigshareUnavailableMessage({ d: { DPID: '1208940001869634' } })).toBeNull();
    expect(bigshareUnavailableMessage({})).toBeNull();
    expect(bigshareUnavailableMessage(null)).toBeNull();
  });

  it('reports an exhausted captcha budget as transient, not as manual work', () => {
    const body = {
      d: {
        Status: 'CAPTCHA',
        Message: 'Invalid captcha code. Please try again.',
        DPID: '',
      },
    };
    // Bigshare's own wording is dropped here: by the time this status
    // survives the retry loop, "please try again" is what already happened.
    expect(bigshareUnavailableMessage(body)).toBe(BIGSHARE_CAPTCHA_UNREAD_MESSAGE);
  });

  it('falls back to the raw Status when Message is absent', () => {
    const body = { d: { Status: 'RATELIMIT' } };
    expect(bigshareUnavailableMessage(body)).toBe(
      "Bigshare couldn't complete this check right now (RATELIMIT) — it will run again automatically.",
    );
  });

  it('passes through the server wording for a refusal that is not a captcha', () => {
    const body = { d: { Status: 'WARMING', Message: 'Service is starting up.' } };
    expect(bigshareUnavailableMessage(body)).toBe(
      "Bigshare couldn't complete this check right now (Service is starting up.) — it will run again automatically.",
    );
  });
});

describe('shouldStopTryingBigshare', () => {
  it('keeps going while failures could still be ordinary bad luck', () => {
    expect(shouldStopTryingBigshare(0)).toBe(false);
    expect(shouldStopTryingBigshare(1)).toBe(false);
  });

  it('stops once a blanket refusal is the better explanation', () => {
    // Two lookups exhausting a 5-attempt budget back to back is ~0.4% likely
    // from misreads alone — see BIGSHARE_BLOCK_TRIP_AFTER.
    expect(shouldStopTryingBigshare(BIGSHARE_BLOCK_TRIP_AFTER)).toBe(true);
    expect(shouldStopTryingBigshare(BIGSHARE_BLOCK_TRIP_AFTER + 3)).toBe(true);
  });
});

describe('bigshareWaitMs', () => {
  it('does not hold a request the gate has already cleared', () => {
    expect(bigshareWaitMs(1_000, 1_000)).toBe(0);
    expect(bigshareWaitMs(1_000, 5_000)).toBe(0);
  });

  it('holds the remainder of the gap when the gate is still closed', () => {
    expect(bigshareWaitMs(5_000, 4_000)).toBe(1_000);
    expect(bigshareWaitMs(5_000, 3_500)).toBe(1_500);
  });

  it('never returns a negative wait, which would be passed to setTimeout', () => {
    expect(bigshareWaitMs(0, 9_999_999)).toBe(0);
  });

  it('spaces fifty requests far enough apart to clear "quick succession"', () => {
    // The block in bigshare.ts's header was provoked by ~50 rapid requests.
    expect(BIGSHARE_MIN_REQUEST_GAP_MS * 50).toBeGreaterThanOrEqual(75_000);
  });
});

describe('bigshareRunDeadlineExceeded', () => {
  it('keeps starting lookups while the run still has time', () => {
    expect(bigshareRunDeadlineExceeded(110_000, 0)).toBe(false);
    expect(bigshareRunDeadlineExceeded(110_000, 109_999)).toBe(false);
  });

  it('stops once the budget is spent, so the invocation can finish writing', () => {
    expect(bigshareRunDeadlineExceeded(110_000, 110_000)).toBe(true);
    expect(bigshareRunDeadlineExceeded(110_000, 200_000)).toBe(true);
  });
});

describe('isRetryableCaptchaStatus', () => {
  it('is true for a rejected captcha — the one case a fresh challenge fixes', () => {
    expect(isRetryableCaptchaStatus('CAPTCHA')).toBe(true);
  });

  it('is false for the back-off statuses, which more attempts would only worsen', () => {
    expect(isRetryableCaptchaStatus('RATELIMIT')).toBe(false);
    expect(isRetryableCaptchaStatus('WARMING')).toBe(false);
  });

  it('is false for an answered query, and for a missing status', () => {
    expect(isRetryableCaptchaStatus('OK')).toBe(false);
    expect(isRetryableCaptchaStatus('NOTFOUND')).toBe(false);
    expect(isRetryableCaptchaStatus(undefined)).toBe(false);
    expect(isRetryableCaptchaStatus(null)).toBe(false);
  });
});

/**
 * Fixtures captured live from https://ipo.bigshareonline.com/Captcha.ashx on
 * 2026-08-26. The real image is a ~5KB base64 data URI; it's truncated here
 * because only the prefix is ever inspected.
 */
describe('parseCaptchaChallenge', () => {
  const TOKEN = '1787723548.ogD3hFPnHidym76n.2z-nyKcHiRdGJh03IxMsuJ0k6sjQnoG2LOeXYscLKao';
  const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAAyCAIAAACWMwO2';

  it('maps the live challenge shape', () => {
    expect(parseCaptchaChallenge({ token: TOKEN, image: IMAGE })).toEqual({
      token: TOKEN,
      image: IMAGE,
    });
  });

  it('accepts the capitalised keys the page also guards against', () => {
    expect(parseCaptchaChallenge({ Token: TOKEN, Image: IMAGE })).toEqual({
      token: TOKEN,
      image: IMAGE,
    });
  });

  it('is null when either half of the challenge is missing', () => {
    expect(parseCaptchaChallenge({ image: IMAGE })).toBeNull();
    expect(parseCaptchaChallenge({ token: TOKEN })).toBeNull();
    expect(parseCaptchaChallenge({ token: '', image: IMAGE })).toBeNull();
    expect(parseCaptchaChallenge({ token: TOKEN, image: '' })).toBeNull();
  });

  it('is null when the image is not a base64 data URI', () => {
    // A relative URL would sail through a presence check and fail later, at
    // the OCR service, a wasted round-trip after this point.
    expect(parseCaptchaChallenge({ token: TOKEN, image: '/Captcha.ashx?id=1' })).toBeNull();
    expect(parseCaptchaChallenge({ token: TOKEN, image: 'data:image/png,notbase64' })).toBeNull();
  });

  it('is null on a malformed or empty body', () => {
    expect(parseCaptchaChallenge({})).toBeNull();
    expect(parseCaptchaChallenge(null)).toBeNull();
    expect(parseCaptchaChallenge({ token: 1, image: 2 })).toBeNull();
  });
});

/** Fixture captured live from the OCR service on 2026-08-26. */
describe('parseOcrAnswer', () => {
  it('takes the text from the live response shape', () => {
    const body = {
      text: '282947',
      confidence: 88,
      agreement: 0.5,
      usedVariants: 4,
      ms: 3733,
      perChar: [{ char: '2', confidence: 96, margin: 1, alternatives: [] }],
    };
    expect(parseOcrAnswer(body)).toBe('282947');
  });

  it('ignores confidence entirely — Bigshare is the only judge that counts', () => {
    // Live-measured: a read at 93 was rejected and one at 68 accepted, so a
    // confidence floor would cost accepted answers and buy nothing. Both of
    // these get submitted.
    expect(parseOcrAnswer({ text: '899528', confidence: 60, agreement: 0 })).toBe('899528');
    expect(parseOcrAnswer({ text: '825399', confidence: 68, agreement: 0.25 })).toBe('825399');
  });

  it('rejects the short read that is a third of live OCR output', () => {
    // The dominant real failure mode: five digits at confidence 0. Catching
    // it here spends a retry instead of a request Bigshare would refuse.
    expect(parseOcrAnswer({ text: '96832', confidence: 0, agreement: 0.75 })).toBeNull();
    expect(parseOcrAnswer({ text: '39898', confidence: 0, agreement: 0.25 })).toBeNull();
  });

  it('is null for any other read that cannot possibly be right', () => {
    expect(parseOcrAnswer({ text: '2829471' })).toBeNull();
    expect(parseOcrAnswer({ text: '28294S' })).toBeNull();
  });

  it('is null when there is no text at all', () => {
    expect(parseOcrAnswer({ confidence: 88 })).toBeNull();
    expect(parseOcrAnswer({ text: 282947 })).toBeNull();
    expect(parseOcrAnswer({})).toBeNull();
    expect(parseOcrAnswer(null)).toBeNull();
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

  // Captured live against SUNSHINE PICTURES LIMITED on 2026-08-26 — the first
  // real allotted record this leg has seen, and the one that showed ALLOTED
  // carries a share count rather than a status word.
  it('reads the confirmed live full allotment as a count, not as unrecognised text', () => {
    expect(bigshareStatusFor('41', 41)).toEqual({ status: 'ALLOTTED', sharesAllotted: 41 });
  });

  it('reports a short allotment as PARTIAL, the way parse.ts and mufg.ts do', () => {
    expect(bigshareStatusFor('20', 41)).toEqual({ status: 'PARTIAL', sharesAllotted: 20 });
  });

  it('is NOT_ALLOTTED for an explicit zero count', () => {
    expect(bigshareStatusFor('0', 41)).toEqual({ status: 'NOT_ALLOTTED', sharesAllotted: 0 });
  });

  it('survives digit grouping, which would otherwise parse as not allotted', () => {
    expect(bigshareStatusFor('1,041', 1041)).toEqual({
      status: 'ALLOTTED',
      sharesAllotted: 1041,
    });
  });

  it('still honours the text sentinel, which is never numeric', () => {
    expect(bigshareStatusFor('NON-ALLOTTE', 41)).toEqual({
      status: 'NOT_ALLOTTED',
      sharesAllotted: 0,
    });
  });
});
