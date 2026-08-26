/**
 * Orchestrates an allotment check from the app, against whichever registrar
 * (KFintech, Bigshare, or MUFG Intime) an IPO is matched to.
 *
 * The actual PAN lookup runs server-side, in supabase/functions/check-
 * allotments's on-demand mode — the same function and code path the 15-
 * minute cron sweep uses, just invoked immediately for named application ids
 * instead of waiting for the schedule. It resolves which registrar to query
 * itself, from whichever company-id column is populated on the IPO row. This
 * file only does two things: make sure the IPO has a match before asking
 * (falling back to sync-ipos's on-demand matcher if it doesn't yet), and
 * invoke the check.
 */
import { supabase } from '../supabase';
import { touchAllotmentChecked } from './applications';

export type RegistrarProvider = 'KFINTECH' | 'BIGSHARE' | 'MUFG';

/** Whichever registrar company id an IPO already carries, or null if none. */
export function resolveRegistrarId(ipo: {
  kfintech_company_id: string | null;
  bigshare_company_id: string | null;
  mufg_company_id: string | null;
}): { provider: RegistrarProvider; companyId: string } | null {
  if (ipo.kfintech_company_id) return { provider: 'KFINTECH', companyId: ipo.kfintech_company_id };
  if (ipo.bigshare_company_id) return { provider: 'BIGSHARE', companyId: ipo.bigshare_company_id };
  if (ipo.mufg_company_id) return { provider: 'MUFG', companyId: ipo.mufg_company_id };
  return null;
}

const RESOLVE_MATCH_BODY: Record<RegistrarProvider, Record<string, boolean>> = {
  KFINTECH: { onlyKfintech: true },
  BIGSHARE: { onlyBigshare: true },
  MUFG: { onlyMufg: true },
};

/**
 * Ask sync-ipos to (re-)try matching this IPO against the given registrar's
 * company list right now, instead of waiting for the twice-daily cron. Runs
 * only that one lightweight leg (no NSE/BSE/ipowatch/GMP scraping), so it's
 * fast enough to call from a button press.
 */
async function resolveRegistrarMatch(
  ipoId: string,
  provider: RegistrarProvider,
): Promise<{ provider: RegistrarProvider; companyId: string } | null> {
  const { error } = await supabase.functions.invoke('sync-ipos', {
    body: RESOLVE_MATCH_BODY[provider],
  });
  // functions.invoke resolves with an `error` rather than throwing — ignoring
  // it here would make a failed invocation (network/auth/timeout) look
  // identical to "invoked fine, genuinely no match", which is exactly the
  // confusing "did this even run?" symptom this guards against.
  if (error) {
    throw new Error(
      'Could not reach the check service — check your connection and try again.',
    );
  }

  const { data } = await supabase
    .from('ipos')
    .select('kfintech_company_id, bigshare_company_id, mufg_company_id')
    .eq('id', ipoId)
    .single();
  return data ? resolveRegistrarId(data) : null;
}

export type OnDemandOutcome =
  | 'resolved'
  | 'not-yet'
  | 'no-match'
  | 'no-pan'
  | 'error';

export type OnDemandCheckResult = {
  id: string;
  outcome: OnDemandOutcome;
  status?: 'ALLOTTED' | 'PARTIAL' | 'NOT_ALLOTTED';
  shares_allotted?: number;
  shares_applied?: number;
  message?: string;
};

/** Invoke check-allotments' on-demand mode for exactly these application ids. */
async function invokeCheck(
  applicationIds: string[],
): Promise<OnDemandCheckResult[]> {
  const { data, error } = await supabase.functions.invoke('check-allotments', {
    body: { applicationIds },
  });
  if (error) {
    throw new Error(
      'Could not reach the check service — check your connection and try again.',
    );
  }
  return (data?.results ?? []) as OnDemandCheckResult[];
}

/**
 * Maps an IPO's display registrar name (as ipogyani writes it — see
 * REGISTRARS in sync-ipos/ipogyani.ts) to the provider sync-ipos knows how
 * to on-demand match against. Any other registrar (one this app doesn't
 * scrape allotment status for at all) returns null — there's no matching leg
 * to fall back to, so the caller stays on "not released yet" rather than
 * trying to invoke a provider that doesn't exist.
 */
function providerFromRegistrarName(registrar: string | null): RegistrarProvider | null {
  if (registrar === 'KFintech') return 'KFINTECH';
  if (registrar === 'Bigshare') return 'BIGSHARE';
  if (registrar === 'MUFG Intime') return 'MUFG';
  return null;
}

/**
 * `ipo` is whatever the caller already has from the `ApplicationPnl`/`Ipo`
 * row it's rendering — passed in rather than re-fetched, since
 * check-allotments loads its own copy of everything else (PAN,
 * application_no) it needs server-side. `registrar` drives which provider to
 * attempt an on-demand match against when neither company id is set yet.
 */
export type RegistrarLookup = {
  kfintech_company_id: string | null;
  bigshare_company_id: string | null;
  mufg_company_id: string | null;
  registrar: string | null;
};

export async function checkAllotment(
  applicationId: string,
  ipo: RegistrarLookup,
  ipoId: string,
): Promise<OnDemandCheckResult> {
  let resolved = resolveRegistrarId(ipo);
  if (!resolved) {
    const provider = providerFromRegistrarName(ipo.registrar);
    if (provider) resolved = await resolveRegistrarMatch(ipoId, provider);
  }
  if (!resolved) {
    // Record the attempt so "Last checked" moves even though this didn't
    // resolve — see the matching comment in checkAllotmentsForIpo.
    await touchAllotmentChecked([applicationId]);
    return {
      id: applicationId,
      outcome: 'no-match',
      message: 'allotment not released yet',
    };
  }

  const [result] = await invokeCheck([applicationId]);
  return result;
}

export type BulkAllotmentCheck =
  | { matched: false; message: string }
  | { matched: true; results: OnDemandCheckResult[] };

/**
 * Check every account that applied to one IPO in a single go. The registrar
 * match is resolved once for the IPO, not once per account — with several
 * accounts pending the same unmatched IPO, resolving it per account meant
 * redundant edge-function calls and the same "not matched yet" message
 * repeated once per account instead of shown once.
 */
export async function checkAllotmentsForIpo(
  ipoId: string,
  applicationIds: string[],
  ipo: RegistrarLookup,
): Promise<BulkAllotmentCheck> {
  let resolved = resolveRegistrarId(ipo);
  if (!resolved) {
    const provider = providerFromRegistrarName(ipo.registrar);
    if (provider) resolved = await resolveRegistrarMatch(ipoId, provider);
  }
  if (!resolved) {
    // Still record that an attempt was made — otherwise "Last checked"
    // never moves on a failed match, which reads as the button doing
    // nothing at all.
    await touchAllotmentChecked(applicationIds);
    return {
      matched: false,
      message: 'allotment not released yet',
    };
  }

  const results = await invokeCheck(applicationIds);
  return { matched: true, results };
}
