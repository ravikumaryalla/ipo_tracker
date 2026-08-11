/**
 * check-allotments — automatically checks KFintech allotment status for
 * every application that's still waiting on one, and writes the result
 * straight into public.ipo_applications.
 *
 * This only exists because PAN became a plain column
 * (see supabase/migrations/20260811000007_pan_plaintext.sql) — that was a
 * deliberate, explicitly-confirmed exception to this project's usual "no
 * plaintext credential column" rule, made specifically so this function
 * could read a PAN without a user's device being involved at all. Every
 * other secret on demat_accounts stays encrypted; this is the one place
 * that trade-off was made on purpose.
 *
 * Schedule: a row becomes a candidate once its IPO's allotment_date has
 * reached 19:00 IST (Basis of Allotment typically finalises in the
 * evening — see parse.ts#isAllotmentCheckDue), and stays a candidate on
 * every hourly run after that until KFintech returns a definitive result
 * (status stops being 'APPLIED', so it drops out of the query on its own —
 * no extra state needed to know when to stop).
 *
 * A WORD OF WARNING, same as sync-ipos: the KFintech endpoint below is
 * undocumented, reverse-engineered from their own frontend bundle (see
 * lib/registrars/kfintech.ts, whose request shape this mirrors exactly for
 * the manual/on-device check). It can change shape without notice. This
 * function is written to degrade rather than break: one application's
 * failure never stops the batch, and every run is recorded in
 * public.sync_log regardless of outcome.
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
  shares_applied: number;
  application_no: string | null;
  ipos: { kfintech_company_id: string | null; allotment_date: string | null } | null;
  demat_accounts: { pan: string | null } | null;
};

/** A CandidateRow that has passed the null/due checks — every field we need is present. */
type DueRow = {
  id: string;
  shares_applied: number;
  application_no: string | null;
  companyId: string;
  pan: string;
};

async function loadCandidates(client: SupabaseClient): Promise<CandidateRow[]> {
  const { data, error } = await client
    .from('ipo_applications')
    .select(
      'id, shares_applied, application_no, ipos(kfintech_company_id, allotment_date), demat_accounts(pan)',
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
      shares_applied: row.shares_applied,
      application_no: row.application_no,
      companyId,
      pan,
    });
  }
  return due;
}

type CheckResult = { row: DueRow; outcome: 'resolved' | 'not-yet' | 'error'; message?: string };

async function checkOne(client: SupabaseClient, row: DueRow): Promise<CheckResult> {
  try {
    const res = await fetch(KFINTECH_QUERY_URL, {
      headers: { ...BROWSER_HEADERS, reqparam: row.pan, client_id: row.companyId },
    });

    if (res.status === 404) return { row, outcome: 'not-yet' };
    if (res.status === 429) throw new Error('KFintech is rate-limiting allotment checks');
    if (!res.ok) throw new Error(`KFintech allotment check responded ${res.status}`);

    const body = await res.json().catch(() => null);
    const matches = parseKfintechAllotmentBody(body);
    if (!matches) return { row, outcome: 'not-yet' };

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

    return { row, outcome: 'resolved' };
  } catch (e) {
    return { row, outcome: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async () => {
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
