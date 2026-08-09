/**
 * IPO applications and the numbers derived from them.
 *
 * Nothing here is encrypted: how many lots you bid for is not a credential, and
 * keeping it in plain columns is what lets Postgres compute the dashboard.
 */
import { supabase } from '../supabase';
import type { ApplicationCategory, ApplicationPnl, ApplicationStatus, IpoApplication } from '../types';
import { dbError } from './error';

export async function listApplications(): Promise<ApplicationPnl[]> {
  const { data, error } = await supabase
    .from('v_application_pnl')
    .select('*')
    .order('applied_at', { ascending: false });
  if (error) throw dbError(error);
  return data;
}

export type ApplicationInput = {
  ipo_id: string;
  demat_account_id: string;
  category: ApplicationCategory;
  lots: number;
  bid_price: number;
  /** Lot size at the time of applying — denormalised so history stays correct. */
  lot_size: number;
  application_no?: string | null;
  upi_ref?: string | null;
  notes?: string | null;
};

/**
 * Money blocked = shares × the price you bid at. For a cut-off bid this is the
 * upper band, which is exactly what the bank blocks.
 */
export function computeAmounts(input: Pick<ApplicationInput, 'lots' | 'lot_size' | 'bid_price'>) {
  const shares_applied = input.lots * input.lot_size;
  return { shares_applied, amount_blocked: shares_applied * input.bid_price };
}

export async function createApplication(
  userId: string,
  input: ApplicationInput,
): Promise<IpoApplication> {
  const { shares_applied, amount_blocked } = computeAmounts(input);

  const { data, error } = await supabase
    .from('ipo_applications')
    .insert({
      user_id: userId,
      ipo_id: input.ipo_id,
      demat_account_id: input.demat_account_id,
      category: input.category,
      lots: input.lots,
      bid_price: input.bid_price,
      shares_applied,
      amount_blocked,
      application_no: input.application_no ?? null,
      upi_ref: input.upi_ref ?? null,
      notes: input.notes ?? null,
    })
    .select()
    .single();

  if (error) {
    // The unique index is a SEBI rule, not a bug — say so plainly.
    if (error.code === '23505') {
      throw new Error('That account already has an application in this category for this IPO.');
    }
    throw dbError(error);
  }
  return data;
}

export async function updateApplicationOutcome(
  id: string,
  patch: {
    status: ApplicationStatus;
    shares_allotted?: number;
    sell_price?: number | null;
    sold_at?: string | null;
  },
): Promise<IpoApplication> {
  const { data, error } = await supabase
    .from('ipo_applications')
    .update({
      ...patch,
      allotment_checked_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw dbError(error);
  return data;
}

export async function deleteApplication(id: string): Promise<void> {
  const { error } = await supabase.from('ipo_applications').delete().eq('id', id);
  if (error) throw dbError(error);
}

// ---------------------------------------------------------------------------
// dashboard maths
// ---------------------------------------------------------------------------

export type PortfolioSummary = {
  totalApplications: number;
  liveApplications: number;
  amountBlocked: number;
  decidedApplications: number;
  allottedApplications: number;
  /** Share of decided applications that got an allotment, 0–1. Null if none decided. */
  allotmentRate: number | null;
  realisedPnl: number;
  unrealisedPnl: number;
  byAccount: { accountId: string; nickname: string; applications: number; pnl: number }[];
};

/**
 * Fold the P&L view into the numbers the dashboard shows.
 *
 * Allotment rate counts only *decided* applications — including still-pending
 * ones would drag the rate down and make a good week look bad.
 */
export function summarise(rows: ApplicationPnl[]): PortfolioSummary {
  const decidedStatuses: ApplicationStatus[] = ['ALLOTTED', 'PARTIAL', 'NOT_ALLOTTED', 'REFUNDED'];
  const allottedStatuses: ApplicationStatus[] = ['ALLOTTED', 'PARTIAL'];

  const byAccount = new Map<string, { nickname: string; applications: number; pnl: number }>();

  let amountBlocked = 0;
  let live = 0;
  let decided = 0;
  let allotted = 0;
  let realisedPnl = 0;
  let unrealisedPnl = 0;

  for (const row of rows) {
    amountBlocked += Number(row.amount_currently_blocked) || 0;
    realisedPnl += Number(row.realised_pnl) || 0;
    unrealisedPnl += Number(row.unrealised_pnl) || 0;

    if (row.status === 'APPLIED') live += 1;
    if (decidedStatuses.includes(row.status)) decided += 1;
    if (allottedStatuses.includes(row.status)) allotted += 1;

    const entry = byAccount.get(row.demat_account_id) ?? {
      nickname: row.account_nickname,
      applications: 0,
      pnl: 0,
    };
    entry.applications += 1;
    entry.pnl += (Number(row.realised_pnl) || 0) + (Number(row.unrealised_pnl) || 0);
    byAccount.set(row.demat_account_id, entry);
  }

  return {
    totalApplications: rows.length,
    liveApplications: live,
    amountBlocked,
    decidedApplications: decided,
    allottedApplications: allotted,
    allotmentRate: decided > 0 ? allotted / decided : null,
    realisedPnl,
    unrealisedPnl,
    byAccount: [...byAccount.entries()]
      .map(([accountId, v]) => ({ accountId, ...v }))
      .sort((a, b) => b.pnl - a.pnl),
  };
}
