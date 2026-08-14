/**
 * Orchestrates a KFintech allotment check from the app.
 *
 * The actual PAN lookup runs server-side, in supabase/functions/check-
 * allotments's on-demand mode — the same function and code path the hourly
 * cron sweep uses, just invoked immediately for named application ids
 * instead of waiting for the schedule. This file only does two things: make
 * sure the IPO has a KFintech match before asking (falling back to
 * sync-ipos's on-demand matcher if it doesn't yet), and invoke the check.
 */
import { supabase } from '../supabase';
import { touchAllotmentChecked } from './applications';

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

export type OnDemandOutcome = 'resolved' | 'not-yet' | 'no-match' | 'no-pan' | 'error';

export type OnDemandCheckResult = {
  id: string;
  outcome: OnDemandOutcome;
  status?: 'ALLOTTED' | 'PARTIAL' | 'NOT_ALLOTTED';
  shares_allotted?: number;
  shares_applied?: number;
  message?: string;
};

/** Invoke check-allotments' on-demand mode for exactly these application ids. */
async function invokeCheck(applicationIds: string[]): Promise<OnDemandCheckResult[]> {
  const { data, error } = await supabase.functions.invoke('check-allotments', {
    body: { applicationIds },
  });
  if (error) {
    throw new Error('Could not reach the check service — check your connection and try again.');
  }
  return (data?.results ?? []) as OnDemandCheckResult[];
}

/**
 * `kfintechCompanyId` is whatever the caller already has from the
 * `ApplicationPnl`/`Ipo` row it's rendering — passed in rather than
 * re-fetched, since check-allotments loads its own copy of everything else
 * (PAN, application_no) it needs server-side.
 */
export async function checkAllotment(
  applicationId: string,
  kfintechCompanyId: string | null,
  ipoId: string,
): Promise<OnDemandCheckResult> {
  let companyId = kfintechCompanyId;
  if (!companyId) companyId = await resolveKfintechMatch(ipoId);
  if (!companyId) {
    // Record the attempt so "Last checked" moves even though this didn't
    // resolve — see the matching comment in checkAllotmentsForIpo.
    await touchAllotmentChecked([applicationId]);
    return {
      id: applicationId,
      outcome: 'no-match',
      message: 'Could not match this IPO to a KFintech-registered issue yet — try again later.',
    };
  }

  const [result] = await invokeCheck([applicationId]);
  return result;
}

export type BulkAllotmentCheck =
  | { matched: false; message: string }
  | { matched: true; results: OnDemandCheckResult[] };

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
  kfintechCompanyId: string | null,
): Promise<BulkAllotmentCheck> {
  let companyId = kfintechCompanyId;
  if (!companyId) companyId = await resolveKfintechMatch(ipoId);
  if (!companyId) {
    // Still record that an attempt was made — otherwise "Last checked"
    // never moves on a failed match, which reads as the button doing
    // nothing at all.
    await touchAllotmentChecked(applicationIds);
    return {
      matched: false,
      message: 'Could not match this IPO to a KFintech-registered issue yet — try again later.',
    };
  }

  const results = await invokeCheck(applicationIds);
  return { matched: true, results };
}
