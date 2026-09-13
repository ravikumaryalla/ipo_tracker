/**
 * Orchestrates an allotment check from the app, against whichever registrar
 * (KFintech, Bigshare, or MUFG Intime) an IPO is matched to.
 *
 * The actual PAN lookup runs server-side, in supabase/functions/check-
 * allotments's on-demand mode — the same function and code path the 15-
 * minute cron sweep uses, just invoked immediately for a named application id
 * instead of waiting for the schedule. It resolves which registrar to query
 * itself, from whichever company-id column is populated on the IPO row.
 *
 * One PAN per invocation, strictly sequential. The function accepts a list and
 * used to be handed every account at once, but a batch meant nothing could be
 * shown until the slowest row finished, one failed captcha could only be
 * retried by re-checking every account, and N Bigshare rows in a single
 * invocation raced BIGSHARE_RUN_DEADLINE_MS (110s, against Supabase's 150s
 * wall clock). Driving the loop from here gives every account its own full
 * captcha budget and deadline, its result the moment it lands, and a retry
 * that costs exactly one lookup.
 *
 * The batch also carried two protections a one-row invocation cannot: the
 * server's per-run Bigshare circuit breaker (it needs two consecutive failures
 * inside one run, which a single row can never reach) and its 1.5s request
 * pacing (module state, so only reliable inside one warm isolate). Both are
 * re-asserted here — see runSequential.
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

const UNREACHABLE_MESSAGE =
  'Could not reach the check service — check your connection and try again.';

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
  if (error) throw new Error(UNREACHABLE_MESSAGE);

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

/**
 * Invoke check-allotments' on-demand mode for exactly one application id.
 *
 * Never throws. A transport failure becomes an `error` result for that one
 * account, which is what makes per-account retry meaningful: one unreachable
 * call must not abandon the accounts queued behind it.
 */
async function invokeCheck(applicationId: string): Promise<OnDemandCheckResult> {
  const { data, error } = await supabase.functions.invoke('check-allotments', {
    body: { applicationIds: [applicationId] },
  });
  if (error) return { id: applicationId, outcome: 'error', message: UNREACHABLE_MESSAGE };

  const results = (data?.results ?? []) as OnDemandCheckResult[];
  return (
    results.find((r) => r.id === applicationId) ?? {
      id: applicationId,
      outcome: 'error',
      message: 'The check service returned no result for this account.',
    }
  );
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

/**
 * Where one account is in the run.
 *
 * Plain objects, never a Map: this lands in the react-query cache, which is
 * persisted to AsyncStorage as JSON (see app/_layout.tsx).
 */
export type AccountCheckState = {
  id: string;
  phase: 'queued' | 'checking' | 'done' | 'skipped';
  /** Present when phase === 'done'. */
  result?: OnDemandCheckResult;
  /** Present when phase === 'skipped' — why the registrar was never asked. */
  message?: string;
};

export type IpoCheckProgress = {
  /** false when the IPO still has no registrar company id — nothing was checked. */
  matched: boolean;
  /** Present when matched === false. */
  message?: string;
  provider: RegistrarProvider | null;
  /** In check order. */
  accounts: AccountCheckState[];
};

/**
 * Worth offering a "Retry" for.
 *
 * `error` is the obvious one. `not-yet` *with a message* is the subtle one:
 * check-allotments reports Bigshare's transient failures that way rather than
 * as errors — an unread captcha, a tripped block, a run that ran out of clock
 * (BIGSHARE_CAPTCHA_UNREAD_MESSAGE and friends in bigshare.ts). Those are
 * failures wearing a "not yet" label, and asking again is exactly what fixes
 * them. A bare `not-yet` is the genuine "results aren't out", which no amount
 * of retrying will change, and `no-pan`/`no-match` need the user to act
 * elsewhere.
 */
export function isRetryable(result: OnDemandCheckResult): boolean {
  if (result.outcome === 'error') return true;
  if (result.outcome === 'not-yet') return !!result.message;
  return false;
}

/** Every account the user could usefully ask about again, in display order. */
export function retryableIds(progress: IpoCheckProgress): string[] {
  return progress.accounts
    .filter(
      (a) =>
        a.phase === 'skipped' ||
        (a.phase === 'done' && !!a.result && isRetryable(a.result)),
    )
    .map((a) => a.id);
}

/**
 * Consecutive unusable Bigshare lookups before this run stops starting more.
 *
 * Mirrors BIGSHARE_BLOCK_TRIP_AFTER in the edge function's bigshare.ts. The
 * server's own breaker lives on a per-invocation BigshareCircuit, so with one
 * account per invocation it can never trip — the protection has to be here or
 * nowhere, and grinding a full captcha budget per account against a wall is
 * the fastest way to earn a longer block.
 *
 * Scoped to Bigshare on purpose. KFintech's pickMatch throws a *permanent*
 * per-row error (two applications on one PAN with no application number to
 * tell them apart); letting two of those trip a run-wide breaker would skip
 * accounts that were about to answer fine.
 */
const CONSECUTIVE_FAILURE_LIMIT = 2;

/**
 * Gap between consecutive Bigshare invocations, matching the edge function's
 * BIGSHARE_MIN_REQUEST_GAP_MS. Its own pacing gate is module state, so it only
 * holds for invocations that land in the same warm isolate — which sequential
 * calls from here are not guaranteed to do.
 */
const BIGSHARE_INTER_CHECK_MS = 1500;

export const REGISTRAR_UNAVAILABLE_MESSAGE =
  'Bigshare stopped answering — skipped so we do not get blocked. Retry in a minute.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withAccount(
  progress: IpoCheckProgress,
  next: AccountCheckState,
): IpoCheckProgress {
  return {
    ...progress,
    accounts: progress.accounts.map((a) => (a.id === next.id ? next : a)),
  };
}

/**
 * Walk `ids` one at a time, publishing after every transition so the screen
 * fills in live rather than all at once at the end.
 */
async function runSequential(
  progress: IpoCheckProgress,
  ids: string[],
  onProgress: (p: IpoCheckProgress) => void,
): Promise<IpoCheckProgress> {
  const paced = progress.provider === 'BIGSHARE';
  let consecutiveFailures = 0;
  let current = progress;

  for (let i = 0; i < ids.length; i += 1) {
    if (paced && consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      const remaining = new Set(ids.slice(i));
      current = {
        ...current,
        accounts: current.accounts.map((a) =>
          remaining.has(a.id)
            ? { id: a.id, phase: 'skipped', message: REGISTRAR_UNAVAILABLE_MESSAGE }
            : a,
        ),
      };
      onProgress(current);
      break;
    }

    const id = ids[i];
    current = withAccount(current, { id, phase: 'checking' });
    onProgress(current);

    const result = await invokeCheck(id);
    current = withAccount(current, { id, phase: 'done', result });
    onProgress(current);

    consecutiveFailures = isRetryable(result) ? consecutiveFailures + 1 : 0;

    if (paced && i < ids.length - 1) await sleep(BIGSHARE_INTER_CHECK_MS);
  }

  return current;
}

/**
 * Check every account that applied to one IPO, one after another.
 *
 * The registrar match is resolved once for the IPO, not once per account —
 * with several accounts pending the same unmatched IPO, resolving it per
 * account meant redundant edge-function calls and the same "not matched yet"
 * message repeated once per account instead of shown once.
 */
export async function runIpoAllotmentCheck(
  ipoId: string,
  applicationIds: string[],
  ipo: RegistrarLookup,
  onProgress: (p: IpoCheckProgress) => void,
): Promise<IpoCheckProgress> {
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
      provider: null,
      accounts: [],
    };
  }

  const queued: IpoCheckProgress = {
    matched: true,
    provider: resolved.provider,
    accounts: applicationIds.map((id) => ({ id, phase: 'queued' as const })),
  };
  onProgress(queued);
  return runSequential(queued, applicationIds, onProgress);
}

/**
 * Re-check exactly `ids` against a run that already happened. The registrar is
 * known from `progress`, so this skips the match step entirely — a retry costs
 * one lookup per account named and leaves every other account's result alone.
 */
export async function retryAllotmentChecks(
  progress: IpoCheckProgress,
  ids: string[],
  onProgress: (p: IpoCheckProgress) => void,
): Promise<IpoCheckProgress> {
  const retrying = new Set(ids);
  const queued: IpoCheckProgress = {
    ...progress,
    accounts: progress.accounts.map((a) =>
      retrying.has(a.id) ? { id: a.id, phase: 'queued' as const } : a,
    ),
  };
  onProgress(queued);
  return runSequential(queued, ids, onProgress);
}
