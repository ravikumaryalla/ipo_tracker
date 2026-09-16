/**
 * check-allotments — two entry points that answer two different questions.
 *
 *  - Scheduled (no request body): **has this IPO's allotment been published
 *    yet?** Per IPO, not per user. Answered from Bigshare's and MUFG's public
 *    company lists, which carry only the issues their lookup will currently
 *    answer for (see registrarWatch.ts). When one appears, every user with an
 *    application on it gets a single "results are out" push and the IPO is
 *    retired from the watch. This path reads no PAN and writes nothing to
 *    ipo_applications.
 *  - On-demand (`{ applicationIds: string[] }` in the body): **what did I
 *    get?** The app's "Check status" button, and the only thing that ever
 *    resolves an application. Queries the registrar with the applicant's PAN
 *    and writes status/shares_allotted, for exactly the ids named.
 *
 * The split is deliberate. The sweep used to do the on-demand path's job on
 * everyone's behalf — one PAN-bearing registrar request per application every
 * two minutes all night — and pushed the outcome, which made the notification
 * the answer and the app somewhere to confirm what you already knew. Now the
 * notification only says a result exists; the user taps it and the app runs
 * the real check (app/allotment/[ipoId].tsx runs it on mount). Nightly
 * registrar load is one public page fetch per registrar instead of one PAN
 * lookup per application, and no PAN leaves the database on a schedule.
 *
 * KFintech is the known gap: its company list is a full directory baked into
 * a JS bundle with no per-issue status, so a KFintech issue is never detected
 * and never notifies. Its users check from the app, as they always could.
 *
 * The PAN column this reads on the on-demand path is plaintext
 * (see supabase/migrations/20260811000007_pan_plaintext.sql) — a deliberate,
 * explicitly-confirmed exception to this project's usual "no plaintext
 * credential column" rule, made so this function could read a PAN without a
 * user's device being involved. Every other secret on demat_accounts stays
 * encrypted; this is the one place that trade-off was made on purpose.
 *
 * The on-demand path is the one place this function trusts caller input, so
 * it verifies the caller actually owns every id it's given (via a second,
 * anon-key + caller-JWT client that resolves the real user id) before the
 * service-role client — which bypasses RLS — ever touches those rows.
 * Skipping that check would let any authenticated user read anyone's
 * allotment result by guessing/reusing an application id.
 *
 * An IPO is watched only inside one window: 21:00 IST on its allotment_date
 * until 08:00 IST the next morning (Basis of Allotment typically finalises in
 * the evening — see parse.ts#isAllotmentCheckDue), rechecked every two minutes
 * until midnight and every five through the overnight tail. Once 08:00 passes
 * the watch gives up for good and no notification is ever sent for that issue;
 * the app's "Check" button is the fallback, as it is for KFintech.
 *
 * That cadence lives in parse.ts and is measured against ipos.
 * allotment_probed_at, not against the cron — the cron simply ticks every
 * minute, and trigger_check_allotments() skips the HTTP call entirely on the
 * ticks where nothing is awaiting a result near its allotment_date (see
 * supabase/migrations/20260916000001_allotment_results_out.sql). Only one
 * sweep runs at a time; claimSweepLease below says why that matters.
 *
 * A WORD OF WARNING, same as sync-ipos: every registrar endpoint below is
 * undocumented, reverse-engineered from their own frontends. Any can change
 * shape without notice. This function is written to degrade rather than
 * break: one registrar being down never stops the other, and one
 * application's failure never stops the batch. Only the scheduled sweep is
 * recorded in public.sync_log — logging every on-demand tap under the same
 * provider tag would make a genuinely broken cron look healthy on the app's
 * staleness banner (see lib/db/ipos.ts).
 *
 * Deploy:  supabase functions deploy check-allotments
 * Invoke:  supabase functions invoke check-allotments
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  BIGSHARE_BLOCKED_MESSAGE,
  BIGSHARE_CAPTCHA_LENGTH,
  BIGSHARE_CAPTCHA_UNREAD_MESSAGE,
  BIGSHARE_DEADLINE_MESSAGE,
  BIGSHARE_MIN_REQUEST_GAP_MS,
  bigshareRunDeadlineExceeded,
  bigshareStatusFor,
  bigshareUnavailableMessage,
  bigshareWaitMs,
  type BigshareCaptchaChallenge,
  isRetryableCaptchaStatus,
  parseBigshareAllotmentBody,
  parseCaptchaChallenge,
  parseOcrAnswer,
  shouldStopTryingBigshare,
} from './bigshare.ts';
import {
  chunkMessages,
  deviceIsGone,
  type ExpoPushMessage,
  parseSendTickets,
} from './expoPush.ts';
import { encryptMufgToken, mufgStatusFor, parseMufgAllotmentBody } from './mufg.ts';
import {
  type AllotmentOutcome,
  isAllotmentCheckDue,
  parseKfintechAllotmentBody,
  pickMatch,
  statusFor,
} from './parse.ts';
import {
  matchWatchedIpos,
  mufgXmlFromBody,
  parseBigshareCompanies,
  parseMufgCompanies,
  type RegistrarCompany,
  type WatchedIpo,
} from './registrarWatch.ts';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const KFINTECH_QUERY_URL =
  'https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query?type=pan';
const BIGSHARE_QUERY_URL = 'https://ipo.bigshareonline.com/Data.aspx/FetchIpodetails';
const BIGSHARE_CAPTCHA_URL = 'https://ipo.bigshareonline.com/Captcha.ashx';

/**
 * The OCR service that reads Bigshare's captcha. Overridable so it can be
 * repointed — or pointed at a local instance — without a redeploy.
 */
const OCR_URL = Deno.env.get('OCR_URL') ?? 'https://ocr-job.onrender.com/ocr';

/**
 * How many fresh captchas to try before giving up on one lookup.
 *
 * Measured over 12 live challenges on 2026-08-26: **a single attempt succeeds
 * 42% of the time.** Compounding that:
 *
 *   1 attempt  42%   3 attempts  80%
 *   2 attempts 66%   5 attempts  93%
 *
 * Five is the point where the curve flattens — a sixth attempt buys ~3 points
 * for another ~4s. At 42% the expected cost is ~2.4 attempts (~10s) per row,
 * not five; the budget only binds on unlucky rows.
 *
 * Three would leave one Bigshare lookup in five failing. There is no sweep to
 * paper over that any more — "Check status" is the only caller, it gets one
 * shot, and a failed row costs the user a visible Retry. The difference between
 * 80% and 93% is the difference between a button that mostly works and one that
 * works.
 */
const BIGSHARE_CAPTCHA_ATTEMPTS = 5;

/**
 * The OCR service sleeps when idle (free tier), and a cold start costs
 * roughly 50s against ~4s warm. A tighter timeout would fail every lookup
 * that happens to be the first one after a quiet spell — which, now that only
 * the on-demand path reaches Bigshare, is most taps.
 */
const OCR_TIMEOUT_MS = 60_000;

/**
 * How long a run may keep starting new Bigshare lookups.
 *
 * Sized against Supabase's free-plan wall clock of 150s (paid is 400s, and
 * this can rise to ~300s there). The margin is deliberate: the deadline only
 * gates *starting* a row, and a row already in flight can still spend a full
 * captcha budget — roughly 25s at worst — before the invocation has to finish
 * writing and reply.
 *
 * See bigshareRunDeadlineExceeded in bigshare.ts for why a time budget became
 * necessary once requests were paced.
 */
const BIGSHARE_RUN_DEADLINE_MS = 110_000;

const MUFG_BASE = 'https://in.mpms.mufg.com/Initial_Offer';
const MUFG_TOKEN_URL = `${MUFG_BASE}/IPO.aspx/generateToken`;
const MUFG_QUERY_URL = `${MUFG_BASE}/IPO.aspx/SearchOnPan`;

type Provider = 'KFINTECH' | 'BIGSHARE' | 'MUFG';

type CandidateRow = {
  id: string;
  user_id: string;
  shares_applied: number;
  application_no: string | null;
  ipos: {
    company_name: string;
    registrar: string | null;
    kfintech_company_id: string | null;
    bigshare_company_id: string | null;
    mufg_company_id: string | null;
  } | null;
  demat_accounts: { pan: string | null } | null;
};

/** A CandidateRow that has passed the null/due checks — every field we need is present. */
type DueRow = {
  id: string;
  userId: string;
  companyName: string;
  shares_applied: number;
  application_no: string | null;
  provider: Provider;
  companyId: string;
  pan: string;
};

/**
 * Which registrar an application's IPO is matched to, or null if neither
 * sync-ipos leg has found a company id for it yet. An issue only ever has
 * one registrar, so KFintech is checked first arbitrarily — there's no case
 * where both are populated.
 */
function resolveProvider(
  ipo: CandidateRow['ipos'],
): { provider: Provider; companyId: string } | null {
  if (ipo?.kfintech_company_id) return { provider: 'KFINTECH', companyId: ipo.kfintech_company_id };
  if (ipo?.bigshare_company_id) return { provider: 'BIGSHARE', companyId: ipo.bigshare_company_id };
  if (ipo?.mufg_company_id) return { provider: 'MUFG', companyId: ipo.mufg_company_id };
  return null;
}

type CheckResult = {
  row: DueRow;
  outcome: 'resolved' | 'not-yet' | 'error';
  status?: AllotmentOutcome;
  shares_allotted?: number;
  message?: string;
};

/**
 * Stamp allotment_checked_at without touching status/shares_allotted.
 *
 * Every path that constitutes an attempt stamps this — resolved, "not yet",
 * outright error, and the no-match/no-pan rejections alike. Only the resolved
 * path knows anything definitive, but "Last checked" answers "when did we last
 * try", not "when did we last succeed": leaving the failure paths unstamped
 * made a check that ran on every sweep and failed every time look like it had
 * never run at all.
 */
async function touchCheckedAt(
  client: SupabaseClient,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await client
    .from('ipo_applications')
    .update({ allotment_checked_at: new Date().toISOString() })
    .in('id', ids);
}

type ProviderCheckResult =
  | { outcome: 'not-yet'; message?: string }
  | { outcome: 'resolved'; status: AllotmentOutcome; sharesAllotted: number };

/**
 * One run's evidence that Bigshare has stopped answering anybody from this
 * address, so the rest of the run can skip it instead of grinding through a
 * full captcha budget per row against a wall.
 *
 * See BIGSHARE_BLOCK_TRIP_AFTER in bigshare.ts for what the count means and
 * why an unbroken streak is the only form of it worth acting on.
 *
 * `deadlineAt` carries the other reason a run stops starting Bigshare
 * lookups: it has run out of wall clock. Both live here because both are
 * one-run state that every row has to consult, and both end a lookup the same
 * way — "not yet", retried by the next sweep.
 */
type BigshareCircuit = { consecutiveExhausted: number; deadlineAt: number };

async function checkOneKfintech(row: DueRow): Promise<ProviderCheckResult> {
  const res = await fetch(KFINTECH_QUERY_URL, {
    headers: {
      ...BROWSER_HEADERS,
      reqparam: row.pan,
      client_id: row.companyId,
    },
  });

  if (res.status === 404) return { outcome: 'not-yet' };
  if (res.status === 429) throw new Error('KFintech is rate-limiting allotment checks');
  if (!res.ok) throw new Error(`KFintech allotment check responded ${res.status}`);

  const body = await res.json().catch(() => null);
  const matches = parseKfintechAllotmentBody(body);
  if (!matches) return { outcome: 'not-yet' };

  const match = pickMatch(matches, row.application_no);
  const status: AllotmentOutcome = statusFor(match, row.shares_applied);
  return { outcome: 'resolved', status, sharesAllotted: match.sharesAllotted };
}

/**
 * The single queue every request to ipo.bigshareonline.com passes through, so
 * that no two of them are ever in flight at once and consecutive ones are at
 * least BIGSHARE_MIN_REQUEST_GAP_MS apart.
 *
 * Chained rather than a bare timestamp comparison, because a comparison is not
 * a lock: two callers reading the same `nextAllowedAt` would both decide they
 * could go. Chaining makes this an actual serial queue, which matters in the
 * one case row-level serialism does not cover — two "Check status" taps (one
 * user's several accounts, or two users) landing in the same warm isolate.
 *
 * Module scope here is deliberate, and is the opposite of the choice made for
 * BigshareCircuit just below. The circuit is per-run precisely so one blocked
 * sweep cannot suppress a later one that would have worked; a throttle has no
 * such failure mode — persisting across invocations in a warm isolate is the
 * entire point, and its worst case is a 1.5s wait.
 */
let bigshareQueue: Promise<unknown> = Promise.resolve();
let bigshareNextAllowedAt = 0;

function pacedBigshareFetch<T>(fn: () => Promise<T>): Promise<T> {
  const result = bigshareQueue.then(async () => {
    const wait = bigshareWaitMs(bigshareNextAllowedAt, Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await fn();
    } finally {
      // Measured from when the request finished rather than when it started:
      // the gentler of the two readings, and the simpler to reason about.
      bigshareNextAllowedAt = Date.now() + BIGSHARE_MIN_REQUEST_GAP_MS;
    }
  });
  // One failed request must not poison the queue for every request behind it.
  bigshareQueue = result.catch(() => {});
  return result;
}

/**
 * Pulls a fresh challenge from Captcha.ashx. See bigshare.ts's header for the
 * shape and lifetime of what comes back; the short version is that it's
 * stateless, so no cookie jar is needed here.
 */
async function fetchBigshareCaptcha(): Promise<BigshareCaptchaChallenge> {
  const res = await pacedBigshareFetch(() =>
    fetch(BIGSHARE_CAPTCHA_URL, {
      headers: {
        ...BROWSER_HEADERS,
        Referer: 'https://ipo.bigshareonline.com/ipo_status.html',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }),
  );

  // 503 is Bigshare shedding load or still warming, per its own page's error
  // handling — same "back off" meaning as 429, so it's reported the same way.
  if (res.status === 429 || res.status === 503) {
    const retryAfter = res.headers.get('Retry-After');
    const wait = retryAfter ? ` (retry after ${retryAfter}s)` : '';
    throw new Error(`Bigshare is rate-limiting captcha requests${wait}`);
  }
  if (!res.ok) throw new Error(`Bigshare captcha request responded ${res.status}`);

  const challenge = parseCaptchaChallenge(await res.json().catch(() => null));
  if (!challenge) throw new Error('Bigshare captcha response was not a usable challenge');
  return challenge;
}

/**
 * Reads a captcha image via the OCR service, or returns null if it couldn't.
 *
 * Null rather than throwing: an unreadable captcha is an ordinary, expected
 * outcome that the caller answers by fetching another one. Only a failure
 * that would repeat identically on the next attempt deserves to abort the
 * lookup, and none of the cases here — service down, cold-start timeout,
 * garbled read — can be told apart from bad luck at this level.
 */
async function solveBigshareCaptcha(image: string): Promise<string | null> {
  try {
    const res = await fetch(OCR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image,
        expectedLength: BIGSHARE_CAPTCHA_LENGTH,
        whitelist: '0123456789',
        debug: false,
      }),
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseOcrAnswer(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

/**
 * Bigshare's response is always a single object, never an array — it
 * resolves (company, PAN) to one application server-side, so there's no
 * pickMatch-style disambiguation to do here. See bigshareStatusFor for how
 * its ALLOTED field encodes an allotted count rather than a status word.
 *
 * Every query needs its own solved captcha, and the OCR read behind it is
 * only sometimes right, so the whole request is wrapped in a retry loop. Two
 * things about that loop are deliberate:
 *
 *  - Each attempt fetches a *new* challenge. Bigshare's captcha is
 *    single-use, so re-posting a rejected token could never succeed.
 *  - The answer is always submitted, never pre-screened on the OCR service's
 *    own confidence score. Bigshare is the ground truth and asking it costs
 *    far less than producing another read — see parseOcrAnswer's comment.
 */
async function checkOneBigshare(
  row: DueRow,
  circuit: BigshareCircuit,
): Promise<ProviderCheckResult> {
  // Bigshare has already refused everything this run — see BigshareCircuit.
  if (shouldStopTryingBigshare(circuit.consecutiveExhausted)) {
    return { outcome: 'not-yet', message: BIGSHARE_BLOCKED_MESSAGE };
  }

  // Out of time. Checked here rather than in runChecks' loop so a skipped row
  // still flows through checkOne, keeping its touchCheckedAt stamping and
  // persistence behaviour without any of it being duplicated.
  if (bigshareRunDeadlineExceeded(circuit.deadlineAt, Date.now())) {
    return { outcome: 'not-yet', message: BIGSHARE_DEADLINE_MESSAGE };
  }

  let body: unknown = null;
  let submitted = false;

  for (let attempt = 1; attempt <= BIGSHARE_CAPTCHA_ATTEMPTS; attempt += 1) {
    const challenge = await fetchBigshareCaptcha();
    const answer = await solveBigshareCaptcha(challenge.image);

    // Nothing usable came back from OCR. The challenge is spent either way,
    // so spend an attempt rather than a request Bigshare would only refuse.
    if (!answer) continue;
    submitted = true;

    const res = await pacedBigshareFetch(() =>
      fetch(BIGSHARE_QUERY_URL, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json; charset=UTF-8',
          Origin: 'https://ipo.bigshareonline.com',
          Referer: 'https://ipo.bigshareonline.com/ipo_status.html',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          Applicationno: '',
          Company: row.companyId,
          SelectionType: 'PN',
          PanNo: row.pan,
          txtcsdl: '',
          txtDPID: '',
          txtClId: '',
          ddlType: '0',
          lang: 'en',
          CaptchaToken: challenge.token,
          CaptchaAnswer: answer,
          // Only ever used to re-read a record a captcha was already solved
          // for, which is never what this is doing. See bigshare.ts's header.
          ResultToken: '',
        }),
      }),
    );

    if (res.status === 429) throw new Error('Bigshare is rate-limiting allotment checks');
    if (!res.ok) throw new Error(`Bigshare allotment check responded ${res.status}`);

    body = await res.json().catch(() => null);

    const status = (body as { d?: { Status?: unknown } } | null)?.d?.Status;
    if (!isRetryableCaptchaStatus(status)) break;
  }

  // Null exactly when Bigshare ran the lookup and answered — which is also
  // the only proof that this address isn't being refused wholesale. Anything
  // else (a spent budget, RATELIMIT, WARMING) is a lookup that produced
  // nothing, and feeds the breaker.
  const unavailable = submitted
    ? bigshareUnavailableMessage(body)
    : BIGSHARE_CAPTCHA_UNREAD_MESSAGE;
  circuit.consecutiveExhausted = unavailable ? circuit.consecutiveExhausted + 1 : 0;

  // Every one of these is transient and retried on the next sweep, so they
  // report "not yet" with an explanation rather than an error or a false
  // not-allotted result. `submitted` being false means OCR never produced
  // anything worth sending, so no query was ever made — without a message
  // that would look indistinguishable from a genuine not-out-yet result.
  if (unavailable) return { outcome: 'not-yet', message: unavailable };

  const match = parseBigshareAllotmentBody(body);
  if (!match) return { outcome: 'not-yet' };

  const { status, sharesAllotted } = bigshareStatusFor(
    match.allotedText,
    match.sharesApplied ?? row.shares_applied,
  );
  return { outcome: 'resolved', status, sharesAllotted };
}

/**
 * Fetches a fresh session token and encrypts it exactly the way MUFG's own
 * public-issues.html does client-side (see mufg.ts's header comment) before
 * every query — generateToken issues a new one per call, so this can't be
 * cached across rows.
 */
async function fetchMufgToken(): Promise<string> {
  const res = await fetch(MUFG_TOKEN_URL, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json;charset:utf-8' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`MUFG generateToken responded ${res.status}`);
  const body = await res.json().catch(() => null);
  const raw = typeof body?.d === 'string' ? body.d : '';
  if (!raw) throw new Error('MUFG generateToken returned no token');
  return encryptMufgToken(raw);
}

async function checkOneMufg(row: DueRow): Promise<ProviderCheckResult> {
  const token = await fetchMufgToken();

  const res = await fetch(MUFG_QUERY_URL, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json; charset=UTF-8',
      Origin: 'https://in.mpms.mufg.com',
      Referer: 'https://in.mpms.mufg.com/Initial_Offer/public-issues.html',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({
      clientid: row.companyId,
      PAN: row.pan,
      IFSC: '',
      CHKVAL: '1',
      token,
    }),
  });

  if (res.status === 429) throw new Error('MUFG is rate-limiting allotment checks');
  if (!res.ok) throw new Error(`MUFG allotment check responded ${res.status}`);

  const body = await res.json().catch(() => null);
  const match = parseMufgAllotmentBody(body);
  if (!match) return { outcome: 'not-yet' };

  const status = mufgStatusFor(match, row.shares_applied);
  return { outcome: 'resolved', status, sharesAllotted: match.sharesAllotted };
}

async function checkOne(
  client: SupabaseClient,
  row: DueRow,
  circuit: BigshareCircuit,
): Promise<CheckResult> {
  try {
    const result =
      row.provider === 'KFINTECH'
        ? await checkOneKfintech(row)
        : row.provider === 'BIGSHARE'
          ? await checkOneBigshare(row, circuit)
          : await checkOneMufg(row);

    if (result.outcome === 'not-yet') {
      await touchCheckedAt(client, [row.id]);
      return { row, outcome: 'not-yet', message: result.message };
    }

    const { error } = await client
      .from('ipo_applications')
      .update({
        status: result.status,
        shares_allotted: result.sharesAllotted,
        allotment_checked_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (error) throw error;

    return {
      row,
      outcome: 'resolved',
      status: result.status,
      shares_allotted: result.sharesAllotted,
    };
  } catch (e) {
    // The attempt happened even though it blew up, so stamp it — but never let
    // a failure to stamp replace the error we're actually reporting.
    await touchCheckedAt(client, [row.id]).catch(() => {});
    return {
      row,
      outcome: 'error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Runs a batch of checks, returned in the same order as `rows`.
 *
 * KFintech and MUFG are one cheap request each and still go out together.
 * Bigshare no longer can: every row needs its own single-use captcha, and
 * firing N of those at Captcha.ashx simultaneously is the fastest way to be
 * rate-limited — which costs far more than the parallelism saves, since a
 * throttled row degrades to "not yet" and, with no sweep left to retry it,
 * waits for the user to tap again. So Bigshare rows go one at a time.
 *
 * One at a time is necessary but not sufficient: a serial loop still fires
 * back-to-back as fast as the network allows, which is its own way to be
 * blocked. pacedBigshareFetch adds the spacing, and `deadlineAt` below bounds
 * what that spacing can cost a single invocation.
 *
 * The caller walks the returned array positionally to build the on-demand
 * response body, so the two groups are stitched back into its original order
 * rather than concatenated.
 */
async function runChecks(client: SupabaseClient, rows: DueRow[]): Promise<CheckResult[]> {
  const results = new Array<CheckResult>(rows.length);

  // Fresh per run. Module scope would persist across invocations in a warm
  // isolate, so one blocked sweep could suppress Bigshare for later ones that
  // would have worked.
  const circuit: BigshareCircuit = {
    consecutiveExhausted: 0,
    deadlineAt: Date.now() + BIGSHARE_RUN_DEADLINE_MS,
  };

  const parallel: number[] = [];
  const serial: number[] = [];
  rows.forEach((row, i) => (row.provider === 'BIGSHARE' ? serial : parallel).push(i));

  const parallelResults = await Promise.all(
    parallel.map((i) => checkOne(client, rows[i], circuit)),
  );
  parallel.forEach((i, n) => (results[i] = parallelResults[n]));

  // Serial also means the breaker actually works: each Bigshare row sees what
  // the previous one learned, which it could not if they all ran at once.
  for (const i of serial) {
    results[i] = await checkOne(client, rows[i], circuit);
  }

  return results;
}

// ---------------------------------------------------------------------------
// on-demand path — the app's "Check status" button
// ---------------------------------------------------------------------------

type OnDemandResult = {
  id: string;
  outcome: 'resolved' | 'not-yet' | 'no-match' | 'no-pan' | 'error';
  status?: AllotmentOutcome;
  shares_allotted?: number;
  shares_applied?: number;
  message?: string;
};

async function loadCandidatesByIds(
  client: SupabaseClient,
  ids: string[],
): Promise<CandidateRow[]> {
  const { data, error } = await client
    .from('ipo_applications')
    .select(
      'id, user_id, shares_applied, application_no, ipos(company_name, registrar, kfintech_company_id, bigshare_company_id, mufg_company_id, allotment_date), demat_accounts(pan)',
    )
    .in('id', ids);
  if (error) throw error;
  return (data ?? []) as unknown as CandidateRow[];
}

// ---------------------------------------------------------------------------
// the watch — "is this IPO's result published?", once per IPO, no PAN
// ---------------------------------------------------------------------------

const BIGSHARE_COMPANIES_URL = 'https://ipo.bigshareonline.com/ipo_status.html';
const MUFG_COMPANIES_URL = `${MUFG_BASE}/IPO.aspx/GetDetails`;

/** An IPO awaiting its result, as loaded for the watch. */
type WatchRow = {
  id: string;
  company_name: string;
  allotment_date: string | null;
  allotment_out_at: string | null;
  allotment_probed_at: string | null;
  bigshare_company_id: string | null;
  mufg_company_id: string | null;
};

/**
 * Every IPO somebody is still waiting on that has not been announced yet.
 *
 * Keyed on allotment_notified_at rather than allotment_out_at, and that is
 * load-bearing: the two columns exist precisely so that detecting a result and
 * announcing it can fail independently. An issue detected on one tick whose
 * push then failed still comes back here on the next one, already carrying its
 * allotment_out_at, and gets announced without troubling the registrar again.
 * Keyed on allotment_out_at instead, that issue would drop out of the watch the
 * instant it was detected and its users would never hear about it at all.
 *
 * The `!inner` embed is the "somebody is waiting" half: without it the watch
 * would poll registrars all night for issues nobody in this database cares
 * about, and would have nobody to notify when one landed. Resolved applications
 * don't count — an IPO whose applications are all ALLOTTED/NOT_ALLOTTED has
 * nothing left to announce.
 */
async function loadWatchedIpos(client: SupabaseClient): Promise<WatchRow[]> {
  const { data, error } = await client
    .from('ipos')
    .select(
      'id, company_name, allotment_date, allotment_out_at, allotment_probed_at, bigshare_company_id, mufg_company_id, ipo_applications!inner(id)',
    )
    .is('allotment_notified_at', null)
    .not('allotment_date', 'is', null)
    .eq('ipo_applications.status', 'APPLIED');
  if (error) throw error;
  return (data ?? []) as unknown as WatchRow[];
}

/** The due subset, by the same window and cadence the old per-row sweep used. */
function dueIpos(watched: WatchRow[], nowIso: string): WatchRow[] {
  return watched.filter(
    (ipo) =>
      !!ipo.allotment_date &&
      isAllotmentCheckDue(ipo.allotment_date, nowIso, ipo.allotment_probed_at),
  );
}

async function fetchBigshareCompanies(): Promise<RegistrarCompany[]> {
  const res = await fetch(BIGSHARE_COMPANIES_URL, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Bigshare status page responded ${res.status}`);
  return parseBigshareCompanies(await res.text());
}

async function fetchMufgCompanies(): Promise<RegistrarCompany[]> {
  const res = await fetch(MUFG_COMPANIES_URL, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json;charset:utf-8' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`MUFG GetDetails responded ${res.status}`);
  return parseMufgCompanies(mufgXmlFromBody(await res.json().catch(() => null)));
}

type Detection = { hits: Map<string, { bigshare?: string; mufg?: string }>; errors: string[] };

/**
 * Which of `due` the registrars are now answering allotment queries for.
 *
 * Both lists are fetched once per sweep, not once per IPO — they are whole-page
 * fetches whose contents don't vary by caller, so asking twice in one run would
 * be pure waste. They are also fetched independently: one registrar being down
 * must not cost us the other's detections, which is the difference between a
 * missed notification and a delayed one.
 *
 * Every due IPO is matched against *both* lists rather than routed by
 * ipos.registrar. That column defaults to 'KFintech' on every row until the
 * ipogyani sync overwrites it (20260813000001_registrar_display_name.sql says
 * as much itself), so routing on it would silently skip real Bigshare and MUFG
 * issues. Both lists are already in hand; the extra comparison costs nothing.
 */
async function detectResultsOut(due: WatchRow[]): Promise<Detection> {
  const hits = new Map<string, { bigshare?: string; mufg?: string }>();
  const errors: string[] = [];
  if (due.length === 0) return { hits, errors };

  const asWatched = (companyId: (row: WatchRow) => string | null): WatchedIpo[] =>
    due.map((row) => ({
      id: row.id,
      companyName: row.company_name,
      companyId: companyId(row),
    }));

  const [bigshare, mufg] = await Promise.all([
    fetchBigshareCompanies().catch((e) => {
      errors.push(`Bigshare: ${e instanceof Error ? e.message : String(e)}`);
      return [] as RegistrarCompany[];
    }),
    fetchMufgCompanies().catch((e) => {
      errors.push(`MUFG: ${e instanceof Error ? e.message : String(e)}`);
      return [] as RegistrarCompany[];
    }),
  ]);

  for (const hit of matchWatchedIpos(bigshare, asWatched((r) => r.bigshare_company_id))) {
    hits.set(hit.ipoId, { ...hits.get(hit.ipoId), bigshare: hit.companyId });
  }
  for (const hit of matchWatchedIpos(mufg, asWatched((r) => r.mufg_company_id))) {
    hits.set(hit.ipoId, { ...hits.get(hit.ipoId), mufg: hit.companyId });
  }

  return { hits, errors };
}

/**
 * Record that an issue's result is published, and backfill the company id the
 * match came from.
 *
 * The backfill is not bookkeeping — it is what makes the notification useful.
 * A newly-listed issue typically has no company id yet (sync-ipos runs twice a
 * day and the issue wasn't listed last time it ran), and without one
 * resolveProvider returns null, so the check the user runs when they tap the
 * push would fail with "hasn't listed this IPO in its allotment lookup yet".
 * Writing it here means the tap works the moment the push lands.
 */
async function markResultsOut(
  client: SupabaseClient,
  ipoId: string,
  companyIds: { bigshare?: string; mufg?: string },
): Promise<void> {
  const patch: Record<string, string> = { allotment_out_at: new Date().toISOString() };
  if (companyIds.bigshare) patch.bigshare_company_id = companyIds.bigshare;
  if (companyIds.mufg) patch.mufg_company_id = companyIds.mufg;

  const { error } = await client.from('ipos').update(patch).eq('id', ipoId);
  if (error) throw error;
}

/**
 * Stamp allotment_probed_at on every IPO the watch looked at.
 *
 * Every attempt stamps, hit or miss or registrar outage — same reasoning as
 * touchCheckedAt above: this answers "when did we last look", not "when did we
 * last find something", and it is what paces the next look.
 */
async function stampProbed(client: SupabaseClient, ipoIds: string[]): Promise<void> {
  if (ipoIds.length === 0) return;
  await client
    .from('ipos')
    .update({ allotment_probed_at: new Date().toISOString() })
    .in('id', ipoIds);
}

// ---------------------------------------------------------------------------
// push notifications — one per applicant, the moment a result is published
// ---------------------------------------------------------------------------

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
type PushSummary = { sent: number; failed: number; pruned: number };

/** One IPO whose result has just been detected as published. */
type NotifiableIpo = { id: string; company_name: string };

/**
 * Tell everyone still waiting on these issues that the result exists.
 *
 * The message deliberately carries no outcome — this path never asked for one.
 * It carries `ipoId`, which app/_layout.tsx routes to /allotment/[ipoId], the
 * screen that runs the real check on mount. One notification per applicant per
 * IPO, however many accounts they applied through: the screen shows all of them
 * together, so a push per application would be the same news three times.
 *
 * Best-effort, like the sender it replaces: a push hiccup (Expo down, a
 * stale/revoked token) must never fail the sweep. Sends in chunks of 100
 * (Expo's per-request cap), drops push_tokens rows Expo reports as dead, and
 * returns a tally the sweep folds into sync_log.
 *
 * `delivered` is what lets the caller stamp allotment_notified_at honestly. An
 * IPO lands in it when at least one of its messages got an ok ticket, and also
 * when it had no devices to send to at all — nobody to tell is a finished job,
 * not a failure to retry nightly. An IPO whose every message failed stays out,
 * so it keeps its null allotment_notified_at, stays in the watch, and is
 * announced again on the next tick without another registrar lookup. Without
 * this the two timestamps would collapse into one and an Expo outage would
 * silently cost everyone the notification.
 */
type PushResult = { summary: PushSummary; delivered: Set<string> };

async function sendResultsOutPushes(
  client: SupabaseClient,
  ipos: NotifiableIpo[],
): Promise<PushResult> {
  const summary: PushSummary = { sent: 0, failed: 0, pruned: 0 };
  const delivered = new Set<string>();
  if (ipos.length === 0) return { summary, delivered };

  try {
    const { data: applicants } = await client
      .from('ipo_applications')
      .select('ipo_id, user_id')
      .eq('status', 'APPLIED')
      .in('ipo_id', ipos.map((i) => i.id));

    // Deduped per IPO: several accounts under one login is the normal case, and
    // each of them would otherwise be a separate copy of the same push.
    const usersByIpo = new Map<string, Set<string>>();
    for (const row of (applicants ?? []) as { ipo_id: string; user_id: string }[]) {
      const users = usersByIpo.get(row.ipo_id) ?? new Set<string>();
      users.add(row.user_id);
      usersByIpo.set(row.ipo_id, users);
    }

    // Nobody left waiting on any of them — nothing to send, nothing to retry.
    const allUsers = [...new Set([...usersByIpo.values()].flatMap((s) => [...s]))];
    if (allUsers.length === 0) {
      for (const ipo of ipos) delivered.add(ipo.id);
      return { summary, delivered };
    }

    const { data: tokenRows } = await client
      .from('push_tokens')
      .select('user_id, token')
      .in('user_id', allUsers);

    const tokensByUser = new Map<string, string[]>();
    for (const t of (tokenRows ?? []) as { user_id: string; token: string }[]) {
      tokensByUser.set(t.user_id, [
        ...(tokensByUser.get(t.user_id) ?? []),
        t.token,
      ]);
    }

    // The ipoId rides *beside* the message, not inside it: Expo is sent exactly
    // the fields it defines, and attribution of the ticket that comes back does
    // not depend on reading the payload shape or on Expo tolerating an extra
    // key. Tickets come back one per message in request order, so the index into
    // a chunk is the link.
    const messages: { message: ExpoPushMessage; ipoId: string }[] = ipos.flatMap((ipo) =>
      [...(usersByIpo.get(ipo.id) ?? [])].flatMap((userId) =>
        (tokensByUser.get(userId) ?? []).map((token) => ({
          ipoId: ipo.id,
          message: {
            to: token,
            title: 'Allotment results are out',
            body: `${ipo.company_name} — tap to check your allotment`,
            sound: 'default' as const,
            channelId: 'allotment-results',
            data: { ipoId: ipo.id },
          },
        })),
      ),
    );
    // Every applicant is on a device with no push token registered. Same as
    // nobody waiting: there is no one to reach, so nothing to retry.
    if (messages.length === 0) {
      for (const ipo of ipos) delivered.add(ipo.id);
      return { summary, delivered };
    }

    const dead = new Set<string>();
    for (const chunk of chunkMessages(messages)) {
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(chunk.map((m) => m.message)),
        });
        const tickets = parseSendTickets(await res.json().catch(() => null));
        // No tickets back means Expo rejected the whole chunk (bad body, auth).
        if (tickets.length === 0) {
          summary.failed += chunk.length;
          continue;
        }
        const chunkDead = new Set<string>();
        let anyOk = false;
        tickets.forEach((ticket, i) => {
          if (ticket.status === 'ok') {
            summary.sent += 1;
            anyOk = true;
            if (chunk[i]) delivered.add(chunk[i].ipoId);
          } else {
            summary.failed += 1;
            if (deviceIsGone(ticket) && chunk[i]) chunkDead.add(chunk[i].message.to);
          }
        });
        // Only prune from a chunk that delivered at least one message. A chunk
        // where every ticket failed is far likelier a misconfigured FCM/APNs
        // credential — which reports every token as DeviceNotRegistered — than
        // 100 genuinely dead devices, and pruning it would empty push_tokens
        // and keep doing so on every sweep.
        if (anyOk) for (const t of chunkDead) dead.add(t);
      } catch {
        summary.failed += chunk.length;
      }
    }

    if (dead.size > 0) {
      const { error } = await client
        .from('push_tokens')
        .delete()
        .in('token', [...dead]);
      if (!error) summary.pruned = dead.size;
    }
  } catch {
    // Never let a push failure surface as a check failure. `delivered` keeps
    // whatever got through before the throw, so a partial run still retires the
    // IPOs it did announce.
  }

  return { summary, delivered };
}

/**
 * Which of the requested ids the caller actually owns. Filtering here rather
 * than erroring on a mismatch means a stale/foreign id in the request just
 * gets silently dropped instead of leaking whether it exists.
 */
async function ownedIds(
  serviceClient: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<Set<string>> {
  const { data, error } = await serviceClient
    .from('ipo_applications')
    .select('id')
    .eq('user_id', userId)
    .in('id', ids);
  if (error) throw error;
  return new Set((data ?? []).map((row: { id: string }) => row.id));
}

async function handleOnDemand(
  req: Request,
  requestedIds: string[],
): Promise<Response> {
  const unauthorized = () =>
    new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return unauthorized();

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  // A second client, scoped to the caller's own JWT rather than the service
  // role, purely to find out who is actually asking — see the file header
  // for why this check exists.
  const callerClient = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      global: { headers: { Authorization: authHeader } },
    },
  );
  const { data: userData, error: userError } =
    await callerClient.auth.getUser();
  if (userError || !userData?.user) return unauthorized();

  const serviceClient = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const allowed = await ownedIds(serviceClient, userData.user.id, requestedIds);
  const idsToCheck = requestedIds.filter((id) => allowed.has(id));

  const candidates =
    idsToCheck.length > 0
      ? await loadCandidatesByIds(serviceClient, idsToCheck)
      : [];

  const results: OnDemandResult[] = [];
  const checkable: DueRow[] = [];
  /** Rejected before KFintech was ever asked — still attempts, so still stamped. */
  const rejected: string[] = [];

  for (const row of candidates) {
    const resolved = resolveProvider(row.ipos);
    const pan = row.demat_accounts?.pan;
    if (!resolved) {
      rejected.push(row.id);
      results.push({
        id: row.id,
        outcome: 'no-match',
        message: row.ipos?.registrar
          ? `${row.ipos.registrar} hasn't listed this IPO in its allotment lookup yet`
          : 'allotment not released yet',
      });
      continue;
    }
    if (!pan) {
      rejected.push(row.id);
      results.push({
        id: row.id,
        outcome: 'no-pan',
        message:
          'The linked demat account has no PAN saved — add it before checking allotment.',
      });
      continue;
    }
    checkable.push({
      id: row.id,
      userId: row.user_id,
      companyName: row.ipos?.company_name ?? 'your IPO',
      shares_applied: row.shares_applied,
      application_no: row.application_no,
      provider: resolved.provider,
      companyId: resolved.companyId,
      pan,
    });
  }

  await touchCheckedAt(serviceClient, rejected);

  const checked = await runChecks(serviceClient, checkable);
  for (const c of checked) {
    results.push({
      id: c.row.id,
      outcome: c.outcome,
      status: c.status,
      shares_allotted: c.shares_allotted,
      shares_applied: c.row.shares_applied,
      message: c.message,
    });
  }

  // No push from this path. The caller is a user looking at the result on
  // screen right now — notifying their own phone about what they just asked for
  // is noise, and the only notification this function still sends is "a result
  // exists", which they plainly already know.

  return new Response(JSON.stringify({ ok: true, results }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * How long a sweep holds the lease, and the row it holds.
 *
 * Comfortably above BIGSHARE_RUN_DEADLINE_MS plus the persistence and push
 * work that follows it, so a healthy sweep always releases the lease itself.
 * The expiry only has to cover the case where an isolate dies mid-run.
 */
const SWEEP_LEASE_MS = 3 * 60 * 1000;
const SWEEP_LEASE_NAME = 'check-allotments';

/**
 * Take the sweep lease, or report that another sweep already holds it.
 *
 * The cron ticks every minute and a sweep can run for the best part of two —
 * BIGSHARE_RUN_DEADLINE_MS alone is 110s — so without this, overlapping
 * invocations would be routine rather than exceptional. The wasted work is
 * the least of it: bigsharePaced's queue and the block circuit-breaker are
 * both per-invocation, so two concurrent sweeps would quietly double the
 * request rate at the one endpoint that has actually blocked us before, and
 * could send the same allotment push twice.
 *
 * The conditional UPDATE *is* the lock. Postgres serialises the two writes,
 * so only one caller can find a still-expired locked_until and claim it.
 * Reading the timestamp and then writing it would not be a lock at all —
 * the same mistake bigsharePaced's chained queue exists to avoid.
 */
async function claimSweepLease(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client
    .from('job_leases')
    .update({ locked_until: new Date(Date.now() + SWEEP_LEASE_MS).toISOString() })
    .eq('name', SWEEP_LEASE_NAME)
    .lt('locked_until', new Date().toISOString())
    .select('name');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Best-effort: a failed release still expires on its own in SWEEP_LEASE_MS. */
async function releaseSweepLease(client: SupabaseClient): Promise<void> {
  await client
    .from('job_leases')
    .update({ locked_until: new Date().toISOString() })
    .eq('name', SWEEP_LEASE_NAME);
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const requestedIds: unknown = body?.applicationIds;
  if (Array.isArray(requestedIds) && requestedIds.length > 0) {
    const ids = requestedIds.filter(
      (id): id is string => typeof id === 'string',
    );
    return handleOnDemand(req, ids);
  }

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let ok = true;
  let checked = 0;
  let resolved = 0;
  let held = false;
  const errors: string[] = [];
  let push: PushSummary = { sent: 0, failed: 0, pruned: 0 };

  try {
    held = await claimSweepLease(client);
    if (!held) {
      return new Response(
        JSON.stringify({ ok: true, skipped: 'lease held' }, null, 2),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const nowIso = new Date().toISOString();
    const watched = await loadWatchedIpos(client);

    // Detected on an earlier tick but never announced — the push failed, or the
    // isolate died between the two. No registrar call can tell us anything new
    // about these, so they skip detection and the cadence gate entirely and go
    // straight back into the fan-out.
    const notifiable: NotifiableIpo[] = watched
      .filter((ipo) => ipo.allotment_out_at !== null)
      .map((ipo) => ({ id: ipo.id, company_name: ipo.company_name }));

    const due = dueIpos(watched.filter((ipo) => ipo.allotment_out_at === null), nowIso);
    checked = due.length;

    const detection = await detectResultsOut(due);
    errors.push(...detection.errors);

    // Marked one at a time, and only the ones that were marked get announced.
    // An IPO whose UPDATE failed must not be notified: allotment_out_at is the
    // record that the result exists, and announcing without it would mean the
    // next tick re-detects and re-announces the same issue.
    for (const ipo of due) {
      const companyIds = detection.hits.get(ipo.id);
      if (!companyIds) continue;
      try {
        await markResultsOut(client, ipo.id, companyIds);
        notifiable.push({ id: ipo.id, company_name: ipo.company_name });
      } catch (e) {
        errors.push(
          `${ipo.company_name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const sendResult = await sendResultsOutPushes(client, notifiable);
    push = sendResult.summary;

    // Only for the IPOs the fan-out actually reached (or found nobody to reach
    // — see sendResultsOutPushes). This is the column the watch selects on, so
    // stamping it is what retires an issue for good; stamping one whose every
    // push failed would turn an Expo outage into a notification nobody ever
    // gets, which is the whole reason it is a separate column from
    // allotment_out_at.
    const notified = notifiable.filter((i) => sendResult.delivered.has(i.id));
    // Counted after the send, not before it: an issue whose push failed has not
    // been announced, and reporting it as though it had would make a night of
    // Expo failures read as a night of successful notifications.
    resolved = notified.length;
    if (notified.length > 0) {
      await client
        .from('ipos')
        .update({ allotment_notified_at: new Date().toISOString() })
        .in('id', notified.map((i) => i.id));
    }

    await stampProbed(client, due.map((i) => i.id));
  } catch (e) {
    ok = false;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    // `held` is false on the early return above, so a sweep never releases a
    // lease it didn't take — and a claim that threw never took one.
    if (held) await releaseSweepLease(client);
  }

  // A tick that watched nothing and announced nothing is the overwhelmingly
  // common case: the cron runs every minute, and even inside the window an IPO
  // is only due every two. Logging each one would write four figures of rows a
  // day and push every other provider out of latestSyncStatus' view, which is
  // exactly the staleness banner this table exists to feed. Errors, and runs
  // that did something, still log — so a broken watch stays visible.
  if (ok && checked === 0 && resolved === 0 && push.failed === 0 && errors.length === 0) {
    return new Response(
      JSON.stringify({ ok, checked, resolved, errors }, null, 2),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const base =
    errors.length > 0
      ? `${checked} watched, ${resolved} announced, ${errors.length} failed: ${errors.slice(0, 3).join('; ')}`
      : `${checked} watched, ${resolved} announced`;
  // Always leave a trace when there was something to announce: a run that found
  // a result but sent nothing means no device is registered (or the push path
  // is broken), and a silent sync_log is how that stayed hidden before.
  const pushNote =
    push.sent + push.failed > 0
      ? `; push ${push.sent} sent` +
        (push.failed > 0 ? `, ${push.failed} failed` : '') +
        (push.pruned > 0 ? `, ${push.pruned} pruned` : '')
      : resolved > 0
        ? '; push 0 sent (no devices registered)'
        : '';

  await client.from('sync_log').insert({
    // Still ALLOTMENT_CHECK: this is the same job from the app's point of view
    // (lib/db/ipos.ts reads it for the staleness banner), and renaming the tag
    // would orphan every historical row and blank the banner.
    provider: 'ALLOTMENT_CHECK',
    ok,
    rows_upserted: resolved,
    message: base + pushNote,
  });

  return new Response(
    JSON.stringify({ ok, checked, resolved, errors }, null, 2),
    {
      status: ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    },
  );
});
