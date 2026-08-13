/**
 * IPO reference data. Nothing here is encrypted — it is public market
 * information, and encrypting it would only make it unsearchable.
 */
import { supabase } from '../supabase';
import type { Ipo, IpoGmp, SyncLogRow } from '../types';
import { dbError } from './error';

export type IpoBucket = 'open' | 'upcoming' | 'closed' | 'listed';

export async function listIpos(): Promise<Ipo[]> {
  const { data, error } = await supabase
    .from('ipos')
    .select('*')
    .order('open_date', { ascending: false, nullsFirst: false });
  if (error) throw dbError(error);
  return data;
}

export async function getIpo(id: string): Promise<Ipo> {
  const { data, error } = await supabase.from('ipos').select('*').eq('id', id).single();
  if (error) throw dbError(error);
  return data;
}

/**
 * Bucket by date rather than by the stored status column. The cron job keeps
 * `status` current, but if it has not run for a day the dates are still right —
 * so dates win for display.
 */
export function bucketOf(ipo: Ipo, today = new Date().toISOString().slice(0, 10)): IpoBucket {
  if (ipo.listing_date && today >= ipo.listing_date) return 'listed';
  if (ipo.open_date && ipo.close_date) {
    if (today < ipo.open_date) return 'upcoming';
    if (today > ipo.close_date) return 'closed';
    return 'open';
  }
  return 'upcoming';
}

export type ManualIpoInput = {
  symbol: string;
  company_name: string;
  segment: 'MAINBOARD' | 'SME';
  open_date: string | null;
  close_date: string | null;
  allotment_date: string | null;
  listing_date: string | null;
  price_band_min: number | null;
  price_band_max: number | null;
  lot_size: number | null;
  registrar: string | null;
};

export async function createManualIpo(userId: string, input: ManualIpoInput): Promise<Ipo> {
  const { data, error } = await supabase
    .from('ipos')
    .insert({ ...input, source: 'MANUAL', created_by: userId, exchange: 'NSE' })
    .select()
    .single();
  if (error) throw dbError(error);
  return data;
}

export async function updateIpo(id: string, patch: Partial<Ipo>): Promise<Ipo> {
  const { data, error } = await supabase.from('ipos').update(patch).eq('id', id).select().single();
  if (error) throw dbError(error);
  return data;
}

/**
 * Providers we plot, best first.
 *
 * ipogyani is preferred because its number is itself an average across several
 * grey-market quoters rather than a single desk's, and it stamps a real
 * timestamp on each reading instead of a minute-resolution local string.
 */
const GMP_PROVIDERS = ['IPOGYANI', 'IPOWATCH'] as const;

/**
 * One provider's readings, not a merge of everyone's.
 *
 * Two feeds write to ipo_gmp for the same IPO and they do not agree — they
 * quote different desks at different times. Interleaving them by timestamp
 * would draw a single line zig-zagging between two series and make `gmpTrend`
 * report the difference between providers as a movement in the market.
 *
 * Pure so it can be tested without a database; `gmpHistory` is the only caller.
 */
export function pickGmpProvider(rows: IpoGmp[]): IpoGmp[] {
  for (const provider of GMP_PROVIDERS) {
    const series = rows.filter((row) => row.provider === provider);
    if (series.length > 0) return series;
  }
  // An unrecognised provider is still better than an empty chart — but never
  // mixed with another one.
  const fallback = rows[0]?.provider;
  return fallback ? rows.filter((row) => row.provider === fallback) : [];
}

/**
 * Grey market premium readings for one IPO, oldest first so a chart can plot
 * them directly.
 *
 * Fetched newest-first and reversed, so `limit` means "the most recent N"
 * rather than "the first N ever recorded". Over-fetched by the number of
 * providers writing, because the rows are filtered down to one provider after
 * the query — asking for exactly `limit` would return a short series whenever
 * both feeds are healthy.
 */
export async function gmpHistory(ipoId: string, limit = 60): Promise<IpoGmp[]> {
  const { data, error } = await supabase
    .from('ipo_gmp')
    .select('*')
    .eq('ipo_id', ipoId)
    .order('observed_at', { ascending: false })
    .limit(limit * GMP_PROVIDERS.length);
  if (error) throw dbError(error);
  return pickGmpProvider(data ?? [])
    .slice(0, limit)
    .reverse();
}

/** Newest reading, or null. Pure — the caller already has the rows. */
export function latestGmp(rows: IpoGmp[]): IpoGmp | null {
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/**
 * Direction of travel between the two most recent readings.
 *
 * A single GMP number is close to noise — whether it is rising into the close
 * is the part anyone actually reads.
 */
export function gmpTrend(rows: IpoGmp[]): 'up' | 'down' | 'flat' | 'unknown' {
  const quoted = rows.filter((row) => row.gmp !== null);
  if (quoted.length < 2) return 'unknown';
  const latest = quoted[quoted.length - 1].gmp!;
  const previous = quoted[quoted.length - 2].gmp!;
  if (latest > previous) return 'up';
  if (latest < previous) return 'down';
  return 'flat';
}

/** GMP goes stale within hours, far faster than the IPO list itself. */
export function gmpIsStale(rows: IpoGmp[], now = new Date(), hours = 24): boolean {
  const latest = latestGmp(rows);
  if (!latest) return true;
  const age = now.getTime() - new Date(latest.observed_at).getTime();
  return age > hours * 60 * 60 * 1000;
}

/**
 * Most recent sync attempt per provider, so the app can say *why* the list
 * looks stale instead of silently showing old data.
 */
export async function latestSyncStatus(): Promise<SyncLogRow[]> {
  const { data, error } = await supabase
    .from('sync_log')
    .select('*')
    .order('ran_at', { ascending: false })
    // Nine providers report per run (NSE, BSE, IPOWATCH, IPOGYANI, REGISTRAR,
    // the two GMP feeds, the shared backfill, and KFINTECH_MATCH), so 20 rows
    // would be barely two runs — not enough to still name a provider that
    // failed a couple of runs ago.
    .limit(45);
  if (error) throw dbError(error);

  const seen = new Set<string>();
  return (data ?? []).filter((row) => {
    if (seen.has(row.provider)) return false;
    seen.add(row.provider);
    return true;
  });
}
