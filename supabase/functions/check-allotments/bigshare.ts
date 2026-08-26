/**
 * Pure parsing and decision logic for Bigshare's allotment-status query,
 * mirroring parse.ts's KFintech equivalent — deliberately free of imports,
 * `Deno.*`, and network calls, so it's the only part of this leg that can be
 * tested under Node.
 *
 * Confirmed live against https://ipo.bigshareonline.com/Data.aspx/FetchIpodetails
 * on 2026-08-19: a match returns
 * `{"d":{"APPLICATION_NO":"...","DPID":"...","Name":"...","APPLIED":"70","ALLOTED":"NON-ALLOTTE",...}}`
 * (unlike KFintech, always a single object, never an array — Bigshare
 * resolves the (company, PAN) pair to one application server-side, so
 * there's no pickMatch-style disambiguation needed here), and a non-match
 * returns the same shape with every field blank except
 * `DPID: "No data found"`.
 *
 * Re-confirmed live on 2026-08-21: the endpoint now gates every query behind
 * a captcha. Posting without `CaptchaToken`/`CaptchaAnswer`/`ResultToken` in
 * the body throws server-side and returns a raw HTTP 500 (regardless of which
 * company or PAN is queried — this is what previously surfaced to users as
 * "Bigshare allotment check responded 500").
 *
 * Solved live on 2026-08-26. The challenge comes from a separate endpoint the
 * page fetches on load and on every refresh:
 *
 *   GET https://ipo.bigshareonline.com/Captcha.ashx
 *   -> {"token":"1787723548.ogD3hFPnHidym76n.2z-nyKcHiRdGJh03Ix...",
 *       "image":"data:image/png;base64,iVBORw0KGgo..."}
 *
 * Four properties of that challenge shape everything below:
 *
 *  - **Stateless.** The response sets no cookie. The token is
 *    `<expiry_epoch>.<nonce>.<hmac>` and the server recomputes the HMAC from
 *    whatever answer is posted back with it, so a plain `fetch` with no
 *    session or cookie jar is enough.
 *  - **~10 minutes to live.** Observed issued 05:42:28Z, expiry 05:52:28Z.
 *    Far longer than a lookup takes, so expiry is not a practical concern.
 *  - **Single-use.** The page's own JS says so, obliquely: `ResultToken`
 *    exists precisely because "a single-use server captcha would force a new
 *    puzzle on every language change". `ResultToken` only ever re-reads the
 *    one record already solved for, so it offers no way to batch a captcha
 *    across different PANs — one lookup costs one captcha, unavoidably, and
 *    a rejected token can never be retried, only replaced.
 *  - **200x50 PNG of six digits.** Matches the markup
 *    (`<img id="captcha" width="200" height="50">`), which is why the OCR
 *    call in index.ts pins `expectedLength: 6` and `whitelist: "0123456789"`.
 *
 * A wrong answer is not an error: the server returns a well-formed HTTP 200
 * carrying `Status: "CAPTCHA"`, which is cheap to detect and retry. That
 * matters a great deal, because OCR reads these correctly only **42% of the
 * time** (measured over 12 live challenges on 2026-08-26). Retrying with a
 * *fresh* challenge is therefore the normal path, not an error path — see
 * BIGSHARE_CAPTCHA_ATTEMPTS in index.ts for how the budget was chosen, and
 * `isRetryableCaptchaStatus` below for where retrying stops being the right
 * answer. `bigshareUnavailableMessage` covers the cases where Bigshare
 * declines to run the lookup at all.
 *
 * The sting in the tail: `Status: "CAPTCHA"` is overloaded. Sustained
 * automated traffic (~50 requests in quick succession, while measuring the
 * above) put this address into a state where *every* submission came back
 * `"CAPTCHA"`, a hand-transcribed and independently verified answer included.
 * So the status means "you misread it" *or* "you are blocked", with nothing
 * in a single response to tell them apart. `shouldStopTryingBigshare` and
 * BIGSHARE_BLOCK_TRIP_AFTER are how a run tells them apart in aggregate
 * instead — without them, a blocked sweep would spend a full captcha budget
 * and five OCR calls on every row, all of it guaranteed to fail.
 *
 * That same measurement also showed the two failure modes worth knowing:
 *
 *  - A third of reads come back the wrong *length* (five digits, always at
 *    confidence 0). `parseOcrAnswer` rejects those locally, which saves a
 *    request Bigshare would certainly have refused.
 *  - Among reads that are the right length, the service's own scores do not
 *    predict acceptance. Rejected reads scored 74, 93 and 74; accepted ones
 *    included a 68. Mean `agreement` was 0.35 for accepted and 0.36 for
 *    rejected — no signal at all. Hence: never threshold on them, just ask
 *    Bigshare.
 */

export type AllotmentOutcome = 'ALLOTTED' | 'PARTIAL' | 'NOT_ALLOTTED';

/** One application Bigshare has on file against the queried (company, PAN). */
export type BigshareAllotmentMatch = {
  applicationNo: string | null;
  dpClientId: string | null;
  applicantName: string | null;
  sharesApplied: number | null;
  /** Raw ALLOTED text, e.g. "NON-ALLOTTE" — kept for bigshareStatusFor. */
  allotedText: string;
};

type BigshareResponse = {
  d?: {
    APPLICATION_NO?: unknown;
    DPID?: unknown;
    Name?: unknown;
    APPLIED?: unknown;
    ALLOTED?: unknown;
    Status?: unknown;
    Message?: unknown;
  };
};

function toNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bigshare's query-endpoint JSON body → a match, or null when there's
 * nothing on file yet for this PAN/issue — not an error, just not out yet.
 * `DPID: "No data found"` is the confirmed no-match sentinel; an empty/absent
 * `d` is treated the same way rather than thrown on, in case a future
 * response shape drops it instead.
 */
export function parseBigshareAllotmentBody(body: unknown): BigshareAllotmentMatch | null {
  const d = (body as BigshareResponse)?.d;
  if (!d) return null;

  const dpClientId = d.DPID != null ? String(d.DPID) : '';
  if (!dpClientId || dpClientId === 'No data found') return null;

  const applicationNo = d.APPLICATION_NO != null ? String(d.APPLICATION_NO) : '';

  return {
    applicationNo: applicationNo || null,
    dpClientId,
    applicantName: d.Name != null ? String(d.Name) : null,
    sharesApplied: toNumberOrNull(d.APPLIED),
    allotedText: d.ALLOTED != null ? String(d.ALLOTED) : '',
  };
}

/**
 * Reported whenever a lookup ends without a captcha ever being accepted —
 * whether Bigshare rejected every answer, or the OCR service never produced
 * one worth submitting. From the user's side those are the same event, and
 * neither is anything they can act on, so both say the same thing.
 */
export const BIGSHARE_CAPTCHA_UNREAD_MESSAGE =
  "Bigshare's captcha couldn't be read this time — this check will run again automatically.";

/**
 * Bigshare's `Status` field is `"OK"` (a real record, handled by
 * `parseBigshareAllotmentBody`) or `"NOTFOUND"` (no record yet, also a plain
 * `null` from that function) on a normal query. Anything else means Bigshare
 * declined to run the lookup, and this returns a user-facing message saying
 * so — or null when the query ran normally.
 *
 * All three refusals are transient and all three are retried on the next
 * sweep, so none of them tells the user to go and check by hand:
 *
 *  - `"CAPTCHA"` reaching here means index.ts spent its whole retry budget
 *    without the OCR service reading a challenge correctly. Unlucky, not
 *    broken.
 *  - `"RATELIMIT"` and `"WARMING"` mean Bigshare is shedding load or still
 *    starting up. The page's own JS locks its search button for 30s and 10s
 *    respectively rather than retrying, and index.ts likewise does not spend
 *    captcha attempts on either.
 */
export function bigshareUnavailableMessage(body: unknown): string | null {
  const d = (body as BigshareResponse)?.d;
  const status = d?.Status != null ? String(d.Status) : '';
  if (!status || status === 'OK' || status === 'NOTFOUND') return null;

  if (status === 'CAPTCHA') return BIGSHARE_CAPTCHA_UNREAD_MESSAGE;

  const detail = d?.Message != null ? String(d.Message) : status;
  return `Bigshare couldn't complete this check right now (${detail}) — it will run again automatically.`;
}

/**
 * Reported to the rows a run skips once Bigshare has started refusing
 * everything. Deliberately says the same kind of thing as the unread message:
 * transient, automatic, nothing for the user to do.
 */
export const BIGSHARE_BLOCKED_MESSAGE =
  "Bigshare is temporarily refusing automated checks — this will run again automatically.";

/**
 * How many lookups may burn their entire captcha budget before a run stops
 * trying Bigshare altogether.
 *
 * Confirmed live on 2026-08-26: after roughly fifty requests in quick
 * succession, Bigshare began returning `Status: "CAPTCHA"` to *every*
 * submission from that address — including a captcha transcribed by hand and
 * verified correct. So this status does not only mean "you misread it"; it
 * also means "you are blocked", and the two are indistinguishable in any
 * single response.
 *
 * They are distinguishable in aggregate. A genuine misread happens ~58% of
 * the time, so one lookup exhausting a 5-attempt budget by bad luck has
 * probability 0.58^5 ≈ 6.6%, and two in a row ≈ 0.4%. Past that point the
 * block is overwhelmingly the better explanation, and continuing costs a
 * captcha fetch plus a ~4s OCR call per attempt for every remaining row —
 * work that cannot succeed, on an endpoint that is already asking for less
 * traffic.
 */
export const BIGSHARE_BLOCK_TRIP_AFTER = 2;

/**
 * Whether a run should stop attempting Bigshare, given how many lookups in a
 * row have used their whole budget without a single accepted captcha.
 *
 * Consecutive, not cumulative: one accepted captcha proves the address is not
 * blocked, so the count resets. Only an unbroken run of total failures is
 * evidence of anything.
 */
export function shouldStopTryingBigshare(consecutiveExhausted: number): boolean {
  return consecutiveExhausted >= BIGSHARE_BLOCK_TRIP_AFTER;
}

/**
 * True only for the status worth spending another captcha on.
 *
 * `"CAPTCHA"` is a plain misread: the challenge is single-use, so the fix is
 * a *fresh* one, and trying again is likely to work. `"RATELIMIT"` and
 * `"WARMING"` are the opposite — Bigshare is asking for less traffic, and
 * burning the remaining attempts on it would be both rude and futile. Every
 * other status (including `"OK"`/`"NOTFOUND"`, which are answers, not
 * refusals) ends the loop too.
 */
export function isRetryableCaptchaStatus(status: unknown): boolean {
  return status === 'CAPTCHA';
}

/** A challenge from Captcha.ashx: the opaque token, and the image to read. */
export type BigshareCaptchaChallenge = { token: string; image: string };

/**
 * Captcha.ashx's JSON body → a usable challenge, or null if it isn't one.
 *
 * Both casings are accepted because the page's own handler does
 * (`r.token || r.Token`), with a comment explaining why: the server emits
 * lowercase now, but a cached older page or a proxy that rewrites JSON
 * shouldn't silently break the captcha. Cheap insurance, so it's mirrored.
 *
 * The image is required to actually be a base64 data URI, since that is what
 * gets forwarded verbatim to the OCR service — a relative URL or an empty
 * string would fail there instead, one wasted round-trip later.
 */
export function parseCaptchaChallenge(body: unknown): BigshareCaptchaChallenge | null {
  const r = body as Record<string, unknown> | null | undefined;
  if (!r) return null;

  const rawToken = r.token ?? r.Token;
  const rawImage = r.image ?? r.Image;
  if (typeof rawToken !== 'string' || typeof rawImage !== 'string') return null;

  const token = rawToken.trim();
  const image = rawImage.trim();
  if (!token || !image) return null;
  if (!image.startsWith('data:image/') || !image.includes(';base64,')) return null;

  return { token, image };
}

/** How many digits a Bigshare captcha carries — see the file header. */
export const BIGSHARE_CAPTCHA_LENGTH = 6;

/**
 * The OCR service's JSON body → the answer to post back, or null if the read
 * is unusable.
 *
 * The service answers with `{"text":"282947","confidence":88,"agreement":0.5,
 * "perChar":[...]}`. Only `text` is used. `confidence` and `agreement` are
 * deliberately *not* thresholded — the live measurement in this file's header
 * found neither predicts whether Bigshare will accept a full-length read, and
 * Bigshare is both the ground truth and the cheaper question to ask (~0.5s to
 * verify against ~4s to produce another read). Any threshold here would
 * discard answers that would have been accepted, and make the retry loop
 * slower rather than faster.
 *
 * What is worth rejecting locally is a read that cannot possibly be right —
 * wrong length, or a character outside the whitelist the service was asked
 * for. That is free to spot and certain to be refused, and it is not a rare
 * case: a third of live reads came back five digits long.
 */
export function parseOcrAnswer(
  body: unknown,
  expectedLength: number = BIGSHARE_CAPTCHA_LENGTH,
): string | null {
  const text = (body as { text?: unknown } | null | undefined)?.text;
  if (typeof text !== 'string') return null;

  const answer = text.trim();
  if (answer.length !== expectedLength) return null;
  if (!/^[0-9]+$/.test(answer)) return null;

  return answer;
}

/**
 * Classifies Bigshare's free-text ALLOTED field into a status, and
 * approximates a share count from it.
 *
 * The only live sample seen so far is the non-allotted case
 * (`"NON-ALLOTTE"`, apparently column-width-truncated from "NON-ALLOTTED") —
 * the allotted spelling is inferred (`"ALLOT"` without a `"NON"`/`"NOT"`
 * prefix), not confirmed, and should be re-checked the first time a real
 * allotted result is available.
 *
 * Unlike KFintech's numeric App_Shares/All_Shares pair, this endpoint gives
 * no allotted-share count at all — just this status text. So a genuine
 * partial allotment can't be distinguished from a full one with the data
 * available here: PARTIAL is never returned by this function. Allotted
 * degrades to "full applied count", not a guessed fraction — reporting a
 * confident wrong number is worse than reporting a knowingly approximate
 * one, but a fabricated partial count would be worse still.
 */
export function bigshareStatusFor(
  allotedText: string,
  sharesApplied: number,
): { status: AllotmentOutcome; sharesAllotted: number } {
  const text = allotedText.toUpperCase();
  const notAllotted = text.includes('NON') || text.includes('NOT');
  const allotted = !notAllotted && text.includes('ALLOT');
  if (allotted) return { status: 'ALLOTTED', sharesAllotted: sharesApplied };
  return { status: 'NOT_ALLOTTED', sharesAllotted: 0 };
}
