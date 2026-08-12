/**
 * Orchestrates a KFintech allotment check.
 *
 * This is the manual, on-demand path: it queries KFintech straight from the
 * device and persists the outcome through the same path a manual update
 * uses. The same check also runs automatically, server-side, on a schedule
 * (supabase/functions/check-allotments) — PAN is a plain column now (see
 * 20260811000007_pan_plaintext.sql), so this no longer needs the vault key
 * either; it works even while the vault is locked. A missing/ambiguous match
 * or a missing PAN is a real error and never touches the application row —
 * but "checked, and the allotment simply hasn't been announced yet" is not
 * an error, and is persisted (see the `!result.found` branch below).
 */
import { checkKfintechAllotment, type KfintechAllotmentMatch } from '../registrars/kfintech';
import { supabase } from '../supabase';
import type { ApplicationStatus, IpoApplication } from '../types';
import { updateApplicationOutcome } from './applications';
import { dbError } from './error';

type CheckRow = {
  id: string;
  ipo_id: string;
  shares_applied: number;
  application_no: string | null;
  ipos: { kfintech_company_id: string | null } | null;
  demat_accounts: { pan: string | null } | null;
};

async function loadCheckRow(applicationId: string): Promise<CheckRow> {
  const { data, error } = await supabase
    .from('ipo_applications')
    .select('id, ipo_id, shares_applied, application_no, ipos(kfintech_company_id), demat_accounts(pan)')
    .eq('id', applicationId)
    .single();
  if (error) throw dbError(error);
  return data as unknown as CheckRow;
}

/**
 * Ask sync-ipos to (re-)try matching this IPO against KFintech's company
 * list right now, instead of waiting for the twice-daily cron. Runs only the
 * lightweight KFintech leg (no NSE/BSE/ipowatch/GMP scraping), so it's fast
 * enough to call from a button press.
 */
async function resolveKfintechMatch(ipoId: string): Promise<string | null> {
  await supabase.functions.invoke('sync-ipos', { body: { onlyKfintech: true } });
  const { data } = await supabase
    .from('ipos')
    .select('kfintech_company_id')
    .eq('id', ipoId)
    .single();
  return data?.kfintech_company_id ?? null;
}

/**
 * Two applications on the same PAN (e.g. retail + shareholder category) come
 * back as two rows from KFintech. Application No. is the only thing that
 * tells them apart — with one candidate there's nothing to disambiguate, and
 * with several we refuse rather than silently attach the wrong one's shares.
 */
export function pickMatch(
  matches: KfintechAllotmentMatch[],
  applicationNo: string | null,
): KfintechAllotmentMatch {
  if (matches.length === 1) return matches[0];
  if (applicationNo) {
    const exact = matches.find((m) => m.applicationNo === applicationNo);
    if (exact) return exact;
  }
  throw new Error(
    'KFintech has more than one application on file for this PAN and issue, and this application ' +
      'has no application number saved to tell them apart. Add the application number, then try again.',
  );
}

export function statusFor(match: KfintechAllotmentMatch, fallbackApplied: number): ApplicationStatus {
  if (match.sharesAllotted <= 0) return 'NOT_ALLOTTED';
  const applied = match.sharesApplied ?? fallbackApplied;
  return match.sharesAllotted < applied ? 'PARTIAL' : 'ALLOTTED';
}

export async function checkAllotment(applicationId: string): Promise<IpoApplication> {
  const row = await loadCheckRow(applicationId);

  let companyId = row.ipos?.kfintech_company_id ?? null;
  if (!companyId) companyId = await resolveKfintechMatch(row.ipo_id);
  if (!companyId) {
    throw new Error('Could not match this IPO to a KFintech-registered issue yet — try again later.');
  }

  const pan = row.demat_accounts?.pan;
  if (!pan) {
    throw new Error('The linked demat account has no PAN saved — add it before checking allotment.');
  }

  const result = await checkKfintechAllotment(companyId, pan);

  if (!result.found) {
    // Not an error — the allotment simply has not been announced yet.
    // `updateApplicationOutcome` always stamps `allotment_checked_at`, so
    // this records the attempt without touching the (unchanged) outcome. A
    // resolved check always moves status away from APPLIED (see
    // `statusFor`), so callers can tell the two apart by that alone.
    return updateApplicationOutcome(applicationId, { status: 'APPLIED' });
  }

  const match = pickMatch(result.matches, row.application_no);

  return updateApplicationOutcome(applicationId, {
    status: statusFor(match, row.shares_applied),
    shares_allotted: match.sharesAllotted,
  });
}

/**
 * Check several applications (e.g. every account that applied to one IPO) in
 * one go. Each one succeeds or fails independently — one account with no PAN
 * saved must not stop the others from resolving.
 */
export async function checkAllotments(
  applicationIds: string[],
): Promise<{ id: string; result: PromiseSettledResult<IpoApplication> }[]> {
  const settled = await Promise.allSettled(applicationIds.map((id) => checkAllotment(id)));
  return applicationIds.map((id, i) => ({ id, result: settled[i] }));
}
