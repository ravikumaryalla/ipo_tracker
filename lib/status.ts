/**
 * How an application's status, and a registrar check's result, are worded and
 * coloured.
 *
 * All of this used to be copied per screen: `outcomeLabel`/`outcomeTone` were
 * byte-identical in the applications tab and IPO detail, the status→tone maps
 * were private to the tab while three other screens wanted them, and the human
 * labels for the status enum existed only inside two `OUTCOMES` arrays. The
 * allotment result screen would have been a third copy of each, so they live
 * here instead.
 *
 * Presentation only — nothing here talks to the database. The one non-type
 * import from lib/db is isRetryable, which is the check protocol's own answer
 * to "is this worth asking again"; duplicating that judgement here is how a
 * Retry button and the run that honours it drift apart.
 */
import type { AllotmentCheckResultTone } from '../components/ui';
import { colors } from '../constants/theme';
import {
  type AccountCheckState,
  isRetryable,
  type OnDemandCheckResult,
} from './db/allotment';
import type { ApplicationPnl, ApplicationStatus } from './types';

export const STATUS_TONE: Record<
  ApplicationStatus,
  'muted' | 'success' | 'warning' | 'danger' | 'accent'
> = {
  APPLIED: 'accent',
  ALLOTTED: 'success',
  PARTIAL: 'success',
  NOT_ALLOTTED: 'muted',
  WITHDRAWN: 'muted',
  REFUNDED: 'warning',
};

export const STATUS_ACCENT: Record<ApplicationStatus, string> = {
  APPLIED: colors.accent,
  ALLOTTED: colors.success,
  PARTIAL: colors.success,
  NOT_ALLOTTED: colors.textMuted,
  WITHDRAWN: colors.textMuted,
  REFUNDED: colors.warning,
};

/** Human wording. The raw enum ("NOT_ALLOTTED") is never put in front of anyone. */
export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  APPLIED: 'Still pending',
  ALLOTTED: 'Allotted',
  PARTIAL: 'Partial',
  NOT_ALLOTTED: 'Not allotted',
  REFUNDED: 'Refunded',
  WITHDRAWN: 'Withdrawn',
};

export function outcomeLabel(r: OnDemandCheckResult): string {
  if (r.outcome === 'resolved') {
    if (r.status === 'ALLOTTED') return `Allotted, ${r.shares_allotted} of ${r.shares_applied} shares`;
    if (r.status === 'PARTIAL') return `Partial, ${r.shares_allotted} of ${r.shares_applied} shares`;
    return 'Not allotted';
  }
  if (r.outcome === 'not-yet') return r.message ?? 'Results were not announced';
  return r.message ?? 'Could not check.';
}

export function outcomeTone(r: OnDemandCheckResult): AllotmentCheckResultTone {
  if (r.outcome === 'resolved') {
    return r.status === 'ALLOTTED' || r.status === 'PARTIAL' ? 'success' : 'neutral';
  }
  if (r.outcome === 'not-yet') return r.message ? 'warning' : 'neutral';
  return 'warning';
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export type AccountOutcome = {
  id: string;
  label: string;
  message: string;
  tone: AllotmentCheckResultTone;
  /** Shares this account got, as far as we know right now. Zero unless allotted. */
  sharesAllotted: number;
  /** A real allotment, as opposed to an unknown, refused or failed check. */
  allotted: boolean;
  /** This account's own lookup is queued or in flight right now. */
  pending: boolean;
  /** Asking the registrar again could plausibly change this row. */
  retryable: boolean;
};

/** What a row that has not reached a verdict yet says while it waits its turn. */
const PHASE_LABEL: Record<'queued' | 'checking', string> = {
  queued: 'Waiting…',
  checking: 'Checking…',
};

/**
 * Resolve one account to the row a result list shows.
 *
 * `state` is where this account is in the run that is happening (or just
 * happened) on screen; without it the application's own stored columns answer
 * instead. That fallback is what lets the result screen render identically
 * whether it just called the registrar or is showing an outcome recorded days
 * ago — and, now that accounts are checked one at a time, it is also what the
 * accounts still queued behind the current one render as.
 */
export function describeRow(row: ApplicationPnl, state?: AccountCheckState): AccountOutcome {
  if (state?.phase === 'queued' || state?.phase === 'checking') {
    return {
      id: row.id,
      label: row.account_nickname,
      message: PHASE_LABEL[state.phase],
      tone: 'neutral',
      sharesAllotted: 0,
      allotted: false,
      pending: true,
      retryable: false,
    };
  }

  // Never asked — the run stopped starting lookups to avoid a registrar block.
  // Always retryable: skipping is the one outcome that carries no information
  // at all about this account.
  if (state?.phase === 'skipped') {
    return {
      id: row.id,
      label: row.account_nickname,
      message: state.message ?? 'Not checked',
      tone: 'warning',
      sharesAllotted: 0,
      allotted: false,
      pending: false,
      retryable: true,
    };
  }

  const live = state?.result;
  if (live) {
    const allotted =
      live.outcome === 'resolved' && (live.status === 'ALLOTTED' || live.status === 'PARTIAL');
    return {
      id: row.id,
      label: row.account_nickname,
      message: outcomeLabel(live),
      tone: outcomeTone(live),
      sharesAllotted: allotted ? (live.shares_allotted ?? 0) : 0,
      allotted,
      pending: false,
      retryable: isRetryable(live),
    };
  }

  const allotted = row.status === 'ALLOTTED' || row.status === 'PARTIAL';
  const message = allotted
    ? `${STATUS_LABEL[row.status]}, ${row.shares_allotted} of ${row.shares_applied} shares`
    : row.status === 'APPLIED'
      ? 'Not checked yet'
      : STATUS_LABEL[row.status];

  return {
    id: row.id,
    label: row.account_nickname,
    message,
    // Still pending reads as warning, not neutral: it is the one state that
    // means "come back later", and neutral would file it alongside a settled
    // "not allotted".
    tone: allotted ? 'success' : row.status === 'APPLIED' ? 'warning' : 'neutral',
    sharesAllotted: allotted ? Number(row.shares_allotted) : 0,
    allotted,
    pending: false,
    retryable: false,
  };
}

export type CheckSummary = {
  totalAccounts: number;
  allottedAccounts: number;
  sharesAllotted: number;
  amountInvested: number;
  /** At least one account has no answer yet — nothing announced, or a failed check. */
  pending: boolean;
  tone: 'success' | 'neutral' | 'warning';
};

/**
 * Fold every account for one IPO into the headline figures.
 *
 * The money is recomputed here as shares × bid price — the same arithmetic
 * `v_application_pnl.amount_invested` does — rather than summed off the rows,
 * so the summary is already right in the render between a check resolving and
 * the invalidated rows coming back.
 */
export function summariseCheck(
  rows: ApplicationPnl[],
  states?: AccountCheckState[],
): CheckSummary {
  const byId = new Map((states ?? []).map((s) => [s.id, s]));

  let allottedAccounts = 0;
  let sharesAllotted = 0;
  let amountInvested = 0;
  let pending = false;

  for (const row of rows) {
    const outcome = describeRow(row, byId.get(row.id));
    if (outcome.allotted) {
      allottedAccounts += 1;
      sharesAllotted += outcome.sharesAllotted;
      amountInvested += outcome.sharesAllotted * Number(row.bid_price);
    }
    if (outcome.tone === 'warning' || outcome.pending) pending = true;
  }

  return {
    totalAccounts: rows.length,
    allottedAccounts,
    sharesAllotted,
    amountInvested,
    pending,
    tone: allottedAccounts > 0 ? 'success' : pending ? 'warning' : 'neutral',
  };
}
