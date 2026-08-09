/**
 * Pure parsing and matching logic for sync-ipos.
 *
 * Everything here is deliberately free of imports, `Deno.*`, and network calls,
 * for one reason: it is the only part of the sync that can be tested. index.ts
 * imports `jsr:@supabase/supabase-js` and calls `Deno.serve`, neither of which
 * Node can load, so anything left in that file is untestable by construction.
 *
 * The Chittorgarh work roughly tripled the amount of parsing, and the matching
 * ladder in `resolveIpoId` is the single place where a bug attaches a grey
 * market chart to the wrong company — which is worse than showing nothing. So
 * it lives here, takes plain Maps rather than a database client, and is covered
 * by parse.test.ts.
 *
 * This file must stay inside supabase/functions/sync-ipos/. The Supabase CLI's
 * bundler roots at supabase/ and parent-directory imports are not reliably
 * included in the deployed eszip.
 */

export type IpoRecord = {
  symbol: string;
  company_name: string;
  exchange: string;
  segment: 'MAINBOARD' | 'SME';
  status: 'UPCOMING' | 'OPEN' | 'CLOSED' | 'LISTED';
  open_date: string | null;
  close_date: string | null;
  /** Only Chittorgarh supplies this; NSE and BSE never do. */
  listing_date: string | null;
  price_band_min: number | null;
  price_band_max: number | null;
  lot_size: number | null;
  issue_size_cr: number | null;
  source: string;
};

/** One grey-market reading, shaped for public.ipo_gmp. */
export type GmpReading = {
  provider: string;
  provider_slug: string;
  company_name: string;
  open_date: string | null;
  observed_at: string;
  gmp: number | null;
  gmp_percent: number | null;
  price: number | null;
  sub_times: number | null;
  source_url: string | null;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** India is UTC+5:30 and never observes DST, so a fixed offset is correct. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// primitives (moved verbatim from index.ts, now tested)
// ---------------------------------------------------------------------------

/** NSE dates look like "09-Aug-2026". Anything unparseable becomes null. */
export function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  const dmy = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dmy) {
    const month = MONTHS.indexOf(dmy[2].toLowerCase());
    if (month >= 0) {
      return `${dmy[3]}-${String(month + 1).padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** "₹ 100 - 105" / "92.00 to 97.00" / "105" → [100, 105]. */
export function parsePriceBand(value: unknown): [number | null, number | null] {
  if (typeof value !== 'string') return [null, null];
  const numbers = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return [null, null];
  const min = Number(numbers[0]);
  const max = numbers.length > 1 ? Number(numbers[1]) : min;
  return [min, max];
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  // Number('') is 0, which would turn an empty or placeholder feed cell ("", "-")
  // into a confident zero — a subscription of 0x and "not quoted" are very
  // different claims. Require an actual digit.
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function statusFor(
  open: string | null,
  close: string | null,
  today = new Date().toISOString().slice(0, 10),
): IpoRecord['status'] {
  if (open && today < open) return 'UPCOMING';
  if (close && today > close) return 'CLOSED';
  if (open && close) return 'OPEN';
  return 'UPCOMING';
}

// ---------------------------------------------------------------------------
// HTML scrubbing
//
// Several feed columns are HTML fragments meant for a browser table. We only
// ever need the text, so a regex is sufficient — no DOM library required, which
// matters because Edge Functions cannot run one cheaply.
// ---------------------------------------------------------------------------

export function stripTags(html: unknown): string {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (
    value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
      // &amp; is decoded last so "&amp;lt;" does not collapse into a real "<".
      .replace(/&(lt|gt|quot|apos|nbsp);/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()])
      .replace(/&amp;/gi, '&')
  );
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * The GMP feed gives a path ("/gmp/qt-foods-ipo/2299/"); the IPO list gives a
 * bare slug ("qt-foods-ipo"). Both normalise to the same key, which is the
 * bridge between the two feeds — verified to match on 30/30 live rows.
 *
 * Note the numeric ids in those paths are NOT a usable join key: the two feeds
 * number the same IPO differently (Q&T Foods is 2299 in one and 3145 in the
 * other), so an id-based join looks stable and is silently wrong.
 */
export function slugFromPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!trimmed.includes('/')) return trimmed;

  const segments = trimmed.split('/').filter(Boolean);
  // Skip the leading section ("gmp", "ipo") and the trailing numeric id.
  const slug = segments.filter((s) => !/^\d+$/.test(s)).pop();
  return slug && slug !== 'gmp' && slug !== 'ipo' ? slug : null;
}

/**
 * Last-resort symbol when neither exchange publishes one — which is the common
 * case: 16 of 30 live issues have no NSE symbol and no BSE code.
 */
export function symbolFromSlug(slug: unknown): string {
  const base = String(slug ?? '')
    .toLowerCase()
    .replace(/-ipo$/, '');
  return base.replace(/[^a-z0-9]/g, '').toUpperCase().slice(0, 20);
}

const NAME_NOISE = /\b(ltd|limited|pvt|private|india|indian|the|inc|corp|corporation|company|co)\b/g;

/**
 * Collapses the many spellings of one company to a single key, so the two feeds
 * can be joined by name when the slug bridge is unavailable.
 *
 * "Q&T Foods", "Q&amp;T Foods", "Q & T Foods Ltd. IPO" and
 * "Q and T Foods Private Limited" must all produce the same string.
 */
export function normalizeName(name: unknown): string {
  return decodeEntities(String(name ?? ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bipo\b/g, ' ')
    .replace(NAME_NOISE, ' ')
    .replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// GMP cells
// ---------------------------------------------------------------------------

/**
 * "&#8377;<b>6</b> (5.22%)<br><small>…</small>" → { gmp: 6, percent: 5.22 }
 *
 * A dealer quoting nothing renders as "--", which must stay null rather than
 * becoming 0 — "no quote" and "no premium" are different claims, and only one
 * of them is a number. When there is no quote the percentage the feed reports
 * alongside it (always "0.00%") is meaningless, so it is dropped too.
 */
export function parseGmp(cell: unknown): { gmp: number | null; percent: number | null } {
  const head = decodeEntities(cell).split(/<br\s*\/?>/i)[0];
  const text = stripTags(head).replace(/₹/g, '').trim();

  const value = text.match(/^(-?\d+(?:\.\d+)?)/);
  if (!value) return { gmp: null, percent: null };

  const percent = text.match(/\((-?\d+(?:\.\d+)?)\s*%\)/);
  return { gmp: Number(value[1]), percent: percent ? Number(percent[1]) : null };
}

/**
 * The feed stamps readings as "9-Aug 23:34" — no year, and in IST.
 *
 * The missing year is inferred from the run date. The rollover guard matters:
 * without it, every December reading fetched on 1 January would be filed under
 * the wrong year, and the unique index would happily accept the duplicates.
 *
 * Falls back to the run timestamp rather than null, because observed_at is NOT
 * NULL and is part of the idempotency key — a null would break dedupe entirely.
 */
export function observedAtFrom(cell: unknown, runIso: string): string {
  const run = new Date(runIso);
  if (Number.isNaN(run.getTime())) return new Date().toISOString();

  const text = stripTags(decodeEntities(cell));
  const m = text.match(/^(\d{1,2})-([A-Za-z]{3})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return run.toISOString();

  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return run.toISOString();

  let year = run.getUTCFullYear();
  const runMonth = run.getUTCMonth();
  if (month === 11 && runMonth === 0) year -= 1; // December reading, January run
  if (month === 0 && runMonth === 11) year += 1; // January reading, December run

  const ms = Date.UTC(year, month, Number(m[1]), Number(m[3]), Number(m[4])) - IST_OFFSET_MS;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** "2026-08-12T00:00:00.000Z" → "2026-08-12"; "" → null. */
function isoDay(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/**
 * Chittorgarh report 82 row → IpoRecord.
 *
 * `priorSymbols` maps `${normalizeName}|${open_date}` to the symbol NSE or BSE
 * already used for that issue *in this same run*. Reusing it is what stops
 * Chittorgarh creating a second `ipos` row for a company the exchanges just
 * wrote under their own symbol.
 */
export function chittorgarhRow(
  row: Record<string, unknown>,
  priorSymbols: Map<string, string> = new Map(),
  today?: string,
): IpoRecord | null {
  const company = decodeEntities(stripTags(row.Company)).trim();
  const open = isoDay(text(row, '~issue_open_date_plan')) ?? parseDate(row['Opening Date']);

  // Mirrors fetchNse's `if (!symbol || !name) continue` — a row we cannot key
  // is worse than a missing row, because the upsert would duplicate it forever.
  if (!company || !open) return null;

  const close = isoDay(text(row, '~IssueCloseDate')) ?? parseDate(row['Closing Date']);
  const slug = text(row, '~URLRewrite_Folder_Name');

  const nse = text(row, '~nse_symbol').toUpperCase();
  const bse = text(row, '~bse_script_code').toUpperCase();
  const prior = priorSymbols.get(`${normalizeName(company)}|${open}`);
  const symbol = nse || bse || prior || symbolFromSlug(slug);
  if (!symbol) return null;

  const listedAt = text(row, 'Listing at').toUpperCase();
  const [min, max] = parsePriceBand(row['Issue Price (Rs.)']);

  return {
    symbol,
    company_name: company,
    exchange: listedAt.includes('NSE') ? 'NSE' : listedAt.includes('BSE') ? 'BSE' : 'NSE',
    segment: text(row, 'Issue Category').toUpperCase() === 'SME' ? 'SME' : 'MAINBOARD',
    status: statusFor(open, close, today),
    open_date: open,
    close_date: close,
    listing_date: isoDay(text(row, '~ListingDate')),
    price_band_min: min,
    price_band_max: max,
    // Report 82 does not carry a lot size. The GMP feed does, but that belongs
    // to the reading, not the issue.
    lot_size: null,
    issue_size_cr: toNumber(row['Issue Amount (Rs.cr.)']),
    source: 'CHITTORGARH',
  };
}

/** InvestorGain report 331 row → GmpReading. */
export function gmpRow(row: Record<string, unknown>, runIso: string): GmpReading | null {
  const path = text(row, '~urlrewrite_folder_name');
  const slug = slugFromPath(path);
  const company = decodeEntities(text(row, '~ipo_name')).trim();
  if (!slug || !company) return null;

  const parsed = parseGmp(row.GMP);
  // The feed computes this itself; prefer it over our regex and fall back only
  // when it is absent.
  const reported = toNumber(row['~gmp_percent_calc']);

  return {
    provider: 'CHITTORGARH',
    provider_slug: slug,
    company_name: company,
    open_date: isoDay(text(row, '~Srt_Open')),
    observed_at: observedAtFrom(row['Updated-On'], runIso),
    gmp: parsed.gmp,
    gmp_percent: parsed.gmp === null ? null : (reported ?? parsed.percent),
    price: toNumber(row['Price (₹)']),
    sub_times: toNumber(row.Sub),
    source_url: path ? `https://www.investorgain.com${path}` : null,
  };
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

export type IpoIndexes = {
  /** `SYMBOL|open_date` → ipos.id */
  bySymbolOpen: Map<string, string>;
  /** `normalizeName|open_date` → ipos.id */
  byNameOpen: Map<string, string>;
  /** normalizeName → every candidate, for the fuzzy date pass. */
  byName: Map<string, { id: string; open_date: string | null }[]>;
};

export function buildIpoIndexes(
  rows: { id: string; symbol: string; company_name: string; open_date: string | null }[],
): IpoIndexes {
  const indexes: IpoIndexes = {
    bySymbolOpen: new Map(),
    byNameOpen: new Map(),
    byName: new Map(),
  };

  for (const row of rows) {
    const name = normalizeName(row.company_name);
    indexes.bySymbolOpen.set(`${row.symbol.toUpperCase()}|${row.open_date}`, row.id);
    indexes.byNameOpen.set(`${name}|${row.open_date}`, row.id);
    const bucket = indexes.byName.get(name);
    if (bucket) bucket.push({ id: row.id, open_date: row.open_date });
    else indexes.byName.set(name, [{ id: row.id, open_date: row.open_date }]);
  }

  return indexes;
}

function daysApart(a: string | null, b: string | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / DAY_MS;
}

/**
 * Attach a GMP reading to an `ipos` row, or refuse.
 *
 * The rungs are ordered most-certain first, and the function returns null
 * rather than guessing. That is deliberate: an unattached reading is retained
 * and retried on the next run, whereas a wrongly attached one silently renders
 * one company's grey market on another company's page, and nothing will alert
 * anyone.
 *
 * Note on the slug rung: it only fires when the Chittorgarh *list* leg
 * succeeded in the same run, because that is what populates `slugIndex`. The
 * GMP feed itself carries no exchange symbol at all (verified against the live
 * payload — there is no ~nse_symbol field), so there is no symbol-based
 * fallback available here; name matching is the safety net.
 */
export function resolveIpoId(
  reading: GmpReading,
  slugIndex: Map<string, { symbol: string; open_date: string | null }>,
  indexes: IpoIndexes,
): string | null {
  // 1. Slug → the symbol Chittorgarh just upserted → the row itself.
  const viaSlug = slugIndex.get(reading.provider_slug);
  if (viaSlug) {
    const id = indexes.bySymbolOpen.get(`${viaSlug.symbol.toUpperCase()}|${viaSlug.open_date}`);
    if (id) return id;
  }

  const name = normalizeName(reading.company_name);
  if (!name) return null;

  // 2. Same company, same open date.
  const exact = indexes.byNameOpen.get(`${name}|${reading.open_date}`);
  if (exact) return exact;

  // 3. Same company, open date within three days — issues get postponed and the
  //    two feeds do not always update in lockstep. Only accept an unambiguous
  //    match; two candidates means we do not actually know which, so refuse.
  const near = (indexes.byName.get(name) ?? []).filter(
    (candidate) => daysApart(candidate.open_date, reading.open_date) <= 3,
  );
  if (near.length === 1) return near[0].id;

  return null;
}

/**
 * The financial year segment the reports are keyed by: April–March, written
 * "2026-27".
 */
export function financialYear(iso: string): string {
  const [year, month] = iso.split('-').map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Which financial years to fetch on a given day.
 *
 * On 1 April the report stops returning the previous year's issues, so an IPO
 * that opened in March vanishes mid-lifecycle. Fetching both years through the
 * first quarter keeps recently-listed issues visible; no test will catch this
 * because it only misbehaves for one quarter a year.
 */
export function financialYearsToFetch(iso: string): string[] {
  const current = financialYear(iso);
  const month = Number(iso.split('-')[1]);
  if (month >= 4 && month <= 6) {
    const [start] = current.split('-').map(Number);
    return [current, `${start - 1}-${String(start % 100).padStart(2, '0')}`];
  }
  return [current];
}
