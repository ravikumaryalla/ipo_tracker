/**
 * check-allotments — checks KFintech, Bigshare, or MUFG Intime allotment
 * status (whichever registrar an application's IPO is matched to — see
 * resolveProvider) and
 * writes the result straight into public.ipo_applications. Two entry points:
 *
 *  - Scheduled (no request body): every application still waiting on a
 *    result, gated by whether its IPO's allotment_date is due yet (see
 *    below). This is the 15-minute cron sweep.
 *  - On-demand (`{ applicationIds: string[] }` in the body): the app's
 *    "Check status" button. Runs the identical check/persist logic against
 *    exactly the ids named, skipping the due-date gate — an explicit user
 *    tap is its own justification, unlike the sweep, which needs the gate
 *    to avoid hammering the registrar before results are plausibly out.
 *
 * This only exists because PAN became a plain column
 * (see supabase/migrations/20260811000007_pan_plaintext.sql) — that was a
 * deliberate, explicitly-confirmed exception to this project's usual "no
 * plaintext credential column" rule, made specifically so this function
 * could read a PAN without a user's device being involved at all. Every
 * other secret on demat_accounts stays encrypted; this is the one place
 * that trade-off was made on purpose.
 *
 * The on-demand path is the one place this function trusts caller input, so
 * it verifies the caller actually owns every id it's given (via a second,
 * anon-key + caller-JWT client that resolves the real user id) before the
 * service-role client — which bypasses RLS — ever touches those rows.
 * Skipping that check would let any authenticated user read anyone's
 * allotment result by guessing/reusing an application id.
 *
 * Scheduled candidates are due only inside one window: 21:00 IST to midnight
 * on their IPO's allotment_date (Basis of Allotment typically finalises in
 * the evening — see parse.ts#isAllotmentCheckDue). Inside it they are
 * rechecked every 15 minutes until KFintech returns a definitive result
 * (status stops being 'APPLIED', so it drops out of the query on its own).
 * Once midnight passes the sweep gives up for good and the on-demand path
 * below is the only way an unresolved application gets checked again.
 *
 * A WORD OF WARNING, same as sync-ipos: both registrar endpoints below are
 * undocumented, reverse-engineered from their own frontends. Either can
 * change shape without notice. This function is written to degrade rather
 * than break: one application's failure never stops the batch. Only the
 * scheduled sweep is recorded in public.sync_log — logging every on-demand
 * tap under the same provider tag would make a genuinely broken cron look
 * healthy on the app's staleness banner (see lib/db/ipos.ts).
 *
 * Deploy:  supabase functions deploy check-allotments
 * Invoke:  supabase functions invoke check-allotments
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { bigshareStatusFor, parseBigshareAllotmentBody } from './bigshare.ts';
import { encryptMufgToken, mufgStatusFor, parseMufgAllotmentBody } from './mufg.ts';
import {
  type AllotmentOutcome,
  isAllotmentCheckDue,
  parseKfintechAllotmentBody,
  pickMatch,
  statusFor,
} from './parse.ts';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const KFINTECH_QUERY_URL =
  'https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query?type=pan';
const BIGSHARE_QUERY_URL = 'https://ipo.bigshareonline.com/Data.aspx/FetchIpodetails';
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
    kfintech_company_id: string | null;
    bigshare_company_id: string | null;
    mufg_company_id: string | null;
    allotment_date: string | null;
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

async function loadCandidates(client: SupabaseClient): Promise<CandidateRow[]> {
  const { data, error } = await client
    .from('ipo_applications')
    .select(
      'id, user_id, shares_applied, application_no, ipos(company_name, kfintech_company_id, bigshare_company_id, mufg_company_id, allotment_date), demat_accounts(pan)',
    )
    .eq('status', 'APPLIED');
  if (error) throw error;
  return (data ?? []) as unknown as CandidateRow[];
}

function dueRows(candidates: CandidateRow[], nowIso: string): DueRow[] {
  const due: DueRow[] = [];
  for (const row of candidates) {
    const resolved = resolveProvider(row.ipos);
    const allotmentDate = row.ipos?.allotment_date;
    const pan = row.demat_accounts?.pan;
    if (!resolved || !allotmentDate || !pan) continue;
    if (!isAllotmentCheckDue(allotmentDate, nowIso)) continue;
    due.push({
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
  return due;
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
  | { outcome: 'not-yet' }
  | { outcome: 'resolved'; status: AllotmentOutcome; sharesAllotted: number };

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
 * Bigshare's response is always a single object, never an array — it
 * resolves (company, PAN) to one application server-side, so there's no
 * pickMatch-style disambiguation to do here. See bigshare.ts for why
 * bigshareStatusFor never returns PARTIAL.
 */
async function checkOneBigshare(row: DueRow): Promise<ProviderCheckResult> {
  const res = await fetch(BIGSHARE_QUERY_URL, {
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
    }),
  });

  if (res.status === 429) throw new Error('Bigshare is rate-limiting allotment checks');
  if (!res.ok) throw new Error(`Bigshare allotment check responded ${res.status}`);

  const body = await res.json().catch(() => null);
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

async function checkOne(client: SupabaseClient, row: DueRow): Promise<CheckResult> {
  try {
    const result =
      row.provider === 'KFINTECH'
        ? await checkOneKfintech(row)
        : row.provider === 'BIGSHARE'
          ? await checkOneBigshare(row)
          : await checkOneMufg(row);

    if (result.outcome === 'not-yet') {
      await touchCheckedAt(client, [row.id]);
      return { row, outcome: 'not-yet' };
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
      'id, user_id, shares_applied, application_no, ipos(company_name, kfintech_company_id, bigshare_company_id, mufg_company_id, allotment_date), demat_accounts(pan)',
    )
    .in('id', ids);
  if (error) throw error;
  return (data ?? []) as unknown as CandidateRow[];
}

// ---------------------------------------------------------------------------
// push notifications — fired the instant a status resolves
// ---------------------------------------------------------------------------

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const OUTCOME_TEXT: Record<AllotmentOutcome, string> = {
  ALLOTTED: 'Allotted',
  PARTIAL: 'Partially allotted',
  NOT_ALLOTTED: 'Not allotted',
};

/**
 * Best-effort: a push-delivery hiccup (Expo's service down, a stale/revoked
 * token) must never fail the check itself — the row is already written by
 * the time this runs.
 */
async function sendAllotmentPushes(
  client: SupabaseClient,
  results: CheckResult[],
): Promise<void> {
  const resolved = results.filter(
    (r): r is CheckResult & { status: AllotmentOutcome } =>
      r.outcome === 'resolved' && !!r.status,
  );
  if (resolved.length === 0) return;

  try {
    const userIds = [...new Set(resolved.map((r) => r.row.userId))];
    const { data: tokenRows } = await client
      .from('push_tokens')
      .select('user_id, token')
      .in('user_id', userIds);

    const tokensByUser = new Map<string, string[]>();
    for (const t of (tokenRows ?? []) as { user_id: string; token: string }[]) {
      tokensByUser.set(t.user_id, [
        ...(tokensByUser.get(t.user_id) ?? []),
        t.token,
      ]);
    }

    const messages = resolved.flatMap((r) =>
      (tokensByUser.get(r.row.userId) ?? []).map((token) => ({
        to: token,
        title: 'Allotment result is out',
        body: `${r.row.companyName}: ${OUTCOME_TEXT[r.status]}`,
        sound: 'default',
        channelId: 'allotment-results',
        data: { applicationId: r.row.id },
      })),
    );
    if (messages.length === 0) return;

    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch {
    // Never let a push failure surface as a check failure.
  }
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
        message: 'allotment not released yet',
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

  const checked = await Promise.all(
    checkable.map((row) => checkOne(serviceClient, row)),
  );
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

  await sendAllotmentPushes(serviceClient, checked);

  return new Response(JSON.stringify({ ok: true, results }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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
  const errors: string[] = [];

  try {
    const nowIso = new Date().toISOString();
    const candidates = await loadCandidates(client);
    const due = dueRows(candidates, nowIso);

    const results = await Promise.all(due.map((row) => checkOne(client, row)));
    checked = results.length;
    for (const result of results) {
      if (result.outcome === 'resolved') resolved += 1;
      else if (result.outcome === 'error' && result.message)
        errors.push(result.message);
    }

    await sendAllotmentPushes(client, results);
  } catch (e) {
    ok = false;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  await client.from('sync_log').insert({
    // Covers both registrars now — see checkOne's dispatch by row.provider.
    provider: 'ALLOTMENT_CHECK',
    ok,
    rows_upserted: resolved,
    message:
      errors.length > 0
        ? `${checked} checked, ${resolved} resolved, ${errors.length} failed: ${errors.slice(0, 3).join('; ')}`
        : `${checked} checked, ${resolved} resolved`,
  });

  return new Response(
    JSON.stringify({ ok, checked, resolved, errors }, null, 2),
    {
      status: ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    },
  );
});
