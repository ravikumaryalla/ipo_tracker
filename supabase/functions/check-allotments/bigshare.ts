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
 * "Bigshare allotment check responded 500"). Including those three fields,
 * even empty, avoids the crash and gets back a well-formed 200 instead:
 * `{"d":{...blank fields...,"Status":"CAPTCHA","Message":"Invalid captcha
 * code. Please try again."}}`. There is no headless way to solve that
 * captcha, so `bigshareUnavailableMessage` exists to tell that case apart
 * from a genuine not-yet-allotted result.
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
 * Bigshare's `Status` field is `"OK"` (a real record, handled by
 * `parseBigshareAllotmentBody`) or `"NOTFOUND"` (no record yet, also a plain
 * `null` from that function) on a normal query. Anything else — currently
 * only ever seen as `"CAPTCHA"`, see the file header, but the page's own JS
 * also handles `"RATELIMIT"` and `"WARMING"` the same way, so all three are
 * treated identically here — means Bigshare refused to actually run the
 * lookup. Returns a user-facing message in that case, or null when the query
 * ran normally.
 */
export function bigshareUnavailableMessage(body: unknown): string | null {
  const d = (body as BigshareResponse)?.d;
  const status = d?.Status != null ? String(d.Status) : '';
  if (!status || status === 'OK' || status === 'NOTFOUND') return null;

  const detail = d?.Message != null ? String(d.Message) : status;
  return `Bigshare couldn't complete this check automatically (${detail}) — check manually at ipo.bigshareonline.com`;
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
