/**
 * check-allotments — checks KFintech allotment status and writes the result
 * straight into public.ipo_applications. Two entry points:
 *
 *  - Scheduled (no request body): every application still waiting on a
 *    result, gated by whether its IPO's allotment_date is due yet (see
 *    below). This is the hourly cron sweep.
 *  - On-demand (`{ applicationIds: string[] }` in the body): the app's
 *    "Check status" button. Runs the identical check/persist logic against
 *    exactly the ids named, skipping the due-date gate — an explicit user
 *    tap is its own justification, unlike the sweep, which needs the gate
 *    to avoid hammering KFintech before results are plausibly out.
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
 * Scheduled candidates become due once their IPO's allotment_date reaches
 * 19:00 IST (Basis of Allotment typically finalises in the evening — see
 * parse.ts#isAllotmentCheckDue), and stay a candidate on every hourly run
 * after that until KFintech returns a definitive result (status stops
 * being 'APPLIED', so it drops out of the query on its own).
 *
 * A WORD OF WARNING, same as sync-ipos: the KFintech endpoint below is
 * undocumented, reverse-engineered from their own frontend bundle. It can
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

const KFINTECH_QUERY_URL = 'https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query?type=pan';

type CandidateRow = {
  id: string;
  user_id: string;
  shares_applied: number;
  application_no: string | null;
  ipos: { company_name: string; kfintech_company_id: string | null; allotment_date: string | null } | null;
  demat_accounts: { pan: string | null } | null;
};

/** A CandidateRow that has passed the null/due checks — every field we need is present. */
type DueRow = {
  id: string;
  userId: string;
  companyName: string;
  shares_applied: number;
  application_no: string | null;
  companyId: string;
  pan: string;
};

async function loadCandidates(client: SupabaseClient): Promise<CandidateRow[]> {
  const { data, error } = await client
    .from('ipo_applications')
    .select(
      'id, user_id, shares_applied, application_no, ipos(company_name, kfintech_company_id, allotment_date), demat_accounts(pan)',
    )
    .eq('status', 'APPLIED');
  if (error) throw error;
  return (data ?? []) as unknown as CandidateRow[];
}

function dueRows(candidates: CandidateRow[], nowIso: string): DueRow[] {
  const due: DueRow[] = [];
  for (const row of candidates) {
    const companyId = row.ipos?.kfintech_company_id;
    const allotmentDate = row.ipos?.allotment_date;
    const pan = row.demat_accounts?.pan;
    if (!companyId || !allotmentDate || !pan) continue;
    if (!isAllotmentCheckDue(allotmentDate, nowIso)) continue;
    due.push({
      id: row.id,
      userId: row.user_id,
      companyName: row.ipos?.company_name ?? 'your IPO',
      shares_applied: row.shares_applied,
      application_no: row.application_no,
      companyId,
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
 * Stamp allotment_checked_at without touching status/shares_allotted — for a
 * "not yet" outcome nothing definitive is known, but the attempt still
 * happened and "Last checked" needs to reflect that (otherwise an on-demand
 * check that comes back inconclusive looks like it never ran).
 */
async function touchCheckedAt(client: SupabaseClient, id: string): Promise<void> {
  await client
    .from('ipo_applications')
    .update({ allotment_checked_at: new Date().toISOString() })
    .eq('id', id);
}

async function checkOne(client: SupabaseClient, row: DueRow): Promise<CheckResult> {
  try {
    const res = await fetch(KFINTECH_QUERY_URL, {
      headers: { ...BROWSER_HEADERS, reqparam: row.pan, client_id: row.companyId },
    });

    if (res.status === 404) {
      await touchCheckedAt(client, row.id);
      return { row, outcome: 'not-yet' };
    }
    if (res.status === 429) throw new Error('KFintech is rate-limiting allotment checks');
    if (!res.ok) throw new Error(`KFintech allotment check responded ${res.status}`);

    const body = await res.json().catch(() => null);
    const matches = parseKfintechAllotmentBody(body);
    if (!matches) {
      await touchCheckedAt(client, row.id);
      return { row, outcome: 'not-yet' };
    }

    const match = pickMatch(matches, row.application_no);
    const status: AllotmentOutcome = statusFor(match, row.shares_applied);

    const { error } = await client
      .from('ipo_applications')
      .update({
        status,
        shares_allotted: match.sharesAllotted,
        allotment_checked_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (error) throw error;

    return { row, outcome: 'resolved', status, shares_allotted: match.sharesAllotted };
  } catch (e) {
    return { row, outcome: 'error', message: e instanceof Error ? e.message : String(e) };
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

async function loadCandidatesByIds(client: SupabaseClient, ids: string[]): Promise<CandidateRow[]> {
  const { data, error } = await client
    .from('ipo_applications')
    .select(
      'id, user_id, shares_applied, application_no, ipos(company_name, kfintech_company_id, allotment_date), demat_accounts(pan)',
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
    (r): r is CheckResult & { status: AllotmentOutcome } => r.outcome === 'resolved' && !!r.status,
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
      tokensByUser.set(t.user_id, [...(tokensByUser.get(t.user_id) ?? []), t.token]);
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
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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

async function handleOnDemand(req: Request, requestedIds: string[]): Promise<Response> {
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
  const callerClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) return unauthorized();

  const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const allowed = await ownedIds(serviceClient, userData.user.id, requestedIds);
  const idsToCheck = requestedIds.filter((id) => allowed.has(id));

  const candidates =
    idsToCheck.length > 0 ? await loadCandidatesByIds(serviceClient, idsToCheck) : [];

  const results: OnDemandResult[] = [];
  const checkable: DueRow[] = [];

  for (const row of candidates) {
    const companyId = row.ipos?.kfintech_company_id;
    const pan = row.demat_accounts?.pan;
    if (!companyId) {
      results.push({
        id: row.id,
        outcome: 'no-match',
        message: 'Could not match this IPO to a KFintech-registered issue yet — try again later.',
      });
      continue;
    }
    if (!pan) {
      results.push({
        id: row.id,
        outcome: 'no-pan',
        message: 'The linked demat account has no PAN saved — add it before checking allotment.',
      });
      continue;
    }
    checkable.push({
      id: row.id,
      userId: row.user_id,
      companyName: row.ipos?.company_name ?? 'your IPO',
      shares_applied: row.shares_applied,
      application_no: row.application_no,
      companyId,
      pan,
    });
  }

  const checked = await Promise.all(checkable.map((row) => checkOne(serviceClient, row)));
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
    const ids = requestedIds.filter((id): id is string => typeof id === 'string');
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
      else if (result.outcome === 'error' && result.message) errors.push(result.message);
    }

    await sendAllotmentPushes(client, results);
  } catch (e) {
    ok = false;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  await client.from('sync_log').insert({
    provider: 'KFINTECH_ALLOTMENT_CHECK',
    ok,
    rows_upserted: resolved,
    message:
      errors.length > 0
        ? `${checked} checked, ${resolved} resolved, ${errors.length} failed: ${errors.slice(0, 3).join('; ')}`
        : `${checked} checked, ${resolved} resolved`,
  });

  return new Response(JSON.stringify({ ok, checked, resolved, errors }, null, 2), {
    status: ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
});
