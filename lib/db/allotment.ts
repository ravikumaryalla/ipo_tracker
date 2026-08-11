/**
 * Orchestrates a KFintech allotment check.
 *
 * This is the manual, on-demand path: it queries KFintech straight from the
 * device and persists the outcome through the same path a manual update
 * uses. The same check also runs automatically, server-side, on a schedule
 * (supabase/functions/check-allotments) — PAN is a plain column now (see
 * 20260811000007_pan_plaintext.sql), so this no longer needs the vault key
 * either; it works even while the vault is locked. A failed or inconclusive
 * check never touches the application row — only a definitive answer does.
 */
import { checkKfintechAllotment, type KfintechAllotmentMatch } from '../registrars/kfintech';
import { supabase } from '../supabase';
import type { ApplicationStatus, IpoApplication } from '../types';
import { updateApplicationOutcome } from './applications';
import { dbError } from './error';

type CheckRow = {
  id: string;
  shares_applied: number;
  application_no: string | null;
  ipos: { kfintech_company_id: string | null } | null;
  demat_accounts: { pan: string | null } | null;
};

async function loadCheckRow(applicationId: string): Promise<CheckRow> {
  const { data, error } = await supabase
    .from('ipo_applications')
    .select('id, shares_applied, application_no, ipos(kfintech_company_id), demat_accounts(pan)')
    .eq('id', applicationId)
    .single();
  if (error) throw dbError(error);
  return data as unknown as CheckRow;
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

  const companyId = row.ipos?.kfintech_company_id;
  if (!companyId) {
    throw new Error('This IPO is not a KFintech-registered issue we can check automatically.');
  }

  const pan = row.demat_accounts?.pan;
  if (!pan) {
    throw new Error('The linked demat account has no PAN saved — add it before checking allotment.');
  }

  const result = await checkKfintechAllotment(companyId, pan);

  if (!result.found) {
    throw new Error('KFintech has no application on file yet for this PAN and issue.');
  }

  const match = pickMatch(result.matches, row.application_no);

  return updateApplicationOutcome(applicationId, {
    status: statusFor(match, row.shares_applied),
    shares_allotted: match.sharesAllotted,
  });
}
