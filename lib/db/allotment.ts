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
  const { error } = await supabase.functions.invoke('sync-ipos', {
    body: { onlyKfintech: true },
  });
  // functions.invoke resolves with an `error` rather than throwing — ignoring
  // it here would make a failed invocation (network/auth/timeout) look
  // identical to "invoked fine, genuinely no match", which is exactly the
  // confusing "did this even run?" symptom this guards against.
  if (error) {
    throw new Error('Could not reach the check service — check your connection and try again.');
  }

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

async function checkAllotmentAgainstCompany(
  row: CheckRow,
  companyId: string,
): Promise<IpoApplication> {
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
    return updateApplicationOutcome(row.id, { status: 'APPLIED' });
  }

  const match = pickMatch(result.matches, row.application_no);

  return updateApplicationOutcome(row.id, {
    status: statusFor(match, row.shares_applied),
    shares_allotted: match.sharesAllotted,
  });
}

export async function checkAllotment(applicationId: string): Promise<IpoApplication> {
  const row = await loadCheckRow(applicationId);

  let companyId = row.ipos?.kfintech_company_id ?? null;
  if (!companyId) companyId = await resolveKfintechMatch(row.ipo_id);
  if (!companyId) {
    // Record the attempt so "Last checked" moves even though this didn't
    // resolve — see the matching comment in checkAllotmentsForIpo.
    await updateApplicationOutcome(applicationId, { status: 'APPLIED' });
    throw new Error('Could not match this IPO to a KFintech-registered issue yet — try again later.');
  }

  return checkAllotmentAgainstCompany(row, companyId);
}

export type BulkAllotmentCheck =
  | { matched: false; message: string }
  | { matched: true; results: { id: string; result: PromiseSettledResult<IpoApplication> }[] };

/**
 * Check every account that applied to one IPO in a single go. The KFintech
 * match is resolved once for the IPO, not once per account — with several
 * accounts pending the same unmatched IPO, resolving it per account meant
 * redundant edge-function calls and the same "not matched yet" message
 * repeated once per account instead of shown once.
 */
export async function checkAllotmentsForIpo(
  ipoId: string,
  applicationIds: string[],
): Promise<BulkAllotmentCheck> {
  const rows = await Promise.all(applicationIds.map((id) => loadCheckRow(id)));

  let companyId = rows[0]?.ipos?.kfintech_company_id ?? null;
  if (!companyId) companyId = await resolveKfintechMatch(ipoId);
  if (!companyId) {
    // Still record that an attempt was made — otherwise "Last checked"
    // never moves on a failed match, which reads as the button doing
    // nothing at all.
    await Promise.all(
      applicationIds.map((id) => updateApplicationOutcome(id, { status: 'APPLIED' })),
    );
    return {
      matched: false,
      message: 'Could not match this IPO to a KFintech-registered issue yet — try again later.',
    };
  }

  const settled = await Promise.allSettled(
    rows.map((row) => checkAllotmentAgainstCompany(row, companyId!)),
  );
  return {
    matched: true,
    results: applicationIds.map((id, i) => ({ id, result: settled[i] })),
  };
}
