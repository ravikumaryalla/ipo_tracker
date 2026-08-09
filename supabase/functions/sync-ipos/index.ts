/**
 * sync-ipos — pulls the current and upcoming IPO list into public.ipos, and
 * grey market premium readings into public.ipo_gmp.
 *
 * A WORD OF WARNING, because it matters for how you read failures here:
 * none of these sources publishes a documented public API. These are the
 * endpoints their own websites call, and they can change shape, add bot
 * checks, or disappear without notice. This function is therefore written to
 * degrade rather than break:
 *
 *   - providers are tried in order and a failure in one does not stop the next
 *   - every attempt is recorded in public.sync_log, success or failure
 *   - the app shows a staleness banner from that log and always offers manual
 *     entry, so a dead scraper never blocks the user
 *
 * Runs with the service role key, which bypasses RLS. It only ever writes the
 * shared `ipos` table (created_by IS NULL), `ipo_gmp`, and `sync_log` — it must
 * never touch user data. Every write below filters on `created_by is null` for
 * exactly that reason.
 *
 * KNOWN GAP: `ipos_symbol_open_idx` is a global unique index on
 * (symbol, open_date), not scoped by created_by. If a user manually adds an IPO
 * that a provider later syncs under the same symbol and open date, the upsert
 * overwrites their row and reassigns it to the shared pool. Fixing that needs
 * partial unique indexes, and Postgres can only use a partial index as an ON
 * CONFLICT arbiter when the inference includes a matching WHERE — which
 * supabase-js's `onConflict` string cannot express. Left open deliberately.
 *
 * Deploy:  supabase functions deploy sync-ipos
 * Invoke:  supabase functions invoke sync-ipos
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  buildIpoIndexes,
  chittorgarhRow,
  financialYearsToFetch,
  type GmpReading,
  gmpRow,
  type IpoRecord,
  normalizeName,
  parseDate,
  parsePriceBand,
  resolveIpoId,
  statusFor,
  toNumber,
} from './parse.ts';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json, text/plain, */*',
};

/** How far either side of today to consider an IPO when matching GMP readings. */
const MATCH_WINDOW_DAYS = 45;

type ProviderResult = {
  provider: string;
  records: IpoRecord[];
  /** slug → the (symbol, open_date) this provider actually upserted. */
  slugIndex?: Map<string, { symbol: string; open_date: string | null }>;
};

/**
 * Providers receive what earlier providers produced in this same run, so a
 * later one can recognise an issue an exchange already wrote and reuse its
 * symbol instead of inventing a second row for the same company.
 */
type Provider = (prior: IpoRecord[]) => Promise<ProviderResult>;

// ---------------------------------------------------------------------------
// provider: NSE
// ---------------------------------------------------------------------------

/**
 * NSE rejects API calls that arrive without a session cookie, so we load the
 * public IPO page first purely to collect one.
 */
async function nseCookie(): Promise<string> {
  const res = await fetch('https://www.nseindia.com/market-data/all-upcoming-issues-ipo', {
    headers: { ...BROWSER_HEADERS, Accept: 'text/html' },
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new Error('NSE did not return a session cookie');
  return cookie;
}

const fetchNse: Provider = async () => {
  const cookie = await nseCookie();

  const endpoints = [
    { url: 'https://www.nseindia.com/api/ipo-current-issue', segment: 'MAINBOARD' as const },
    {
      url: 'https://www.nseindia.com/api/all-upcoming-issues?category=ipo',
      segment: 'MAINBOARD' as const,
    },
    { url: 'https://www.nseindia.com/api/ipo-detail?index=sme', segment: 'SME' as const },
  ];

  const records: IpoRecord[] = [];

  for (const endpoint of endpoints) {
    const res = await fetch(endpoint.url, {
      headers: { ...BROWSER_HEADERS, Cookie: cookie, Referer: 'https://www.nseindia.com/' },
    });
    if (!res.ok) continue;

    const body = await res.json().catch(() => null);
    const rows: unknown[] = Array.isArray(body) ? body : (body?.data ?? []);

    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const symbol = String(row.symbol ?? row.Symbol ?? '').trim();
      const name = String(row.companyName ?? row.company_name ?? row.issuerName ?? '').trim();
      if (!symbol || !name) continue;

      const open = parseDate(row.issueStartDate ?? row.startDate ?? row.bidStartDate);
      const close = parseDate(row.issueEndDate ?? row.endDate ?? row.bidEndDate);
      const [min, max] = parsePriceBand(row.priceBand ?? row.issuePrice ?? '');

      records.push({
        symbol,
        company_name: name,
        exchange: 'NSE',
        segment: endpoint.segment,
        status: statusFor(open, close),
        open_date: open,
        close_date: close,
        listing_date: null,
        price_band_min: min,
        price_band_max: max,
        lot_size: toNumber(row.lotSize ?? row.marketLot ?? row.minBidQuantity),
        issue_size_cr: toNumber(row.issueSize ?? row.issueSizeInCr),
        source: 'NSE',
      });
    }
  }

  if (records.length === 0) throw new Error('NSE returned no usable rows');
  return { provider: 'NSE', records };
};

// ---------------------------------------------------------------------------
// provider: BSE
// ---------------------------------------------------------------------------

const fetchBse: Provider = async () => {
  const res = await fetch(
    'https://api.bseindia.com/BseIndiaAPI/api/GetPublicIssues/w?Ftype=1&Fdate=&Tdate=',
    { headers: { ...BROWSER_HEADERS, Referer: 'https://www.bseindia.com/' } },
  );
  if (!res.ok) throw new Error(`BSE responded ${res.status}`);

  const body = await res.json().catch(() => null);
  const rows: unknown[] = Array.isArray(body) ? body : (body?.Table ?? []);
  const records: IpoRecord[] = [];

  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const name = String(row.Issuer_Name ?? row.scrip_name ?? '').trim();
    if (!name) continue;

    const open = parseDate(row.Issue_Open_Date ?? row.StartDate);
    const close = parseDate(row.Issue_Close_Date ?? row.EndDate);

    records.push({
      symbol: String(row.scrip_cd ?? row.Scrip_Id ?? name.slice(0, 12)).trim().toUpperCase(),
      company_name: name,
      exchange: 'BSE',
      segment: String(row.Issue_Type ?? '').toUpperCase().includes('SME') ? 'SME' : 'MAINBOARD',
      status: statusFor(open, close),
      open_date: open,
      close_date: close,
      listing_date: null,
      price_band_min: toNumber(row.Issue_Price_From ?? row.PriceFrom),
      price_band_max: toNumber(row.Issue_Price_To ?? row.PriceTo),
      lot_size: toNumber(row.Market_Lot ?? row.MarketLot),
      issue_size_cr: toNumber(row.Issue_Size),
      source: 'BSE',
    });
  }

  if (records.length === 0) throw new Error('BSE returned no usable rows');
  return { provider: 'BSE', records };
};

// ---------------------------------------------------------------------------
// provider: Chittorgarh
//
// Their front-end calls this JSON endpoint directly, so no HTML parsing and no
// DOM library is needed. Note the GMP feed further down lives on
// investorgain.com — same publisher, different host, and the path prefixes are
// NOT interchangeable (chittorgarh 404s on /cloud/v2/, investorgain 404s on
// /cloud/). That is not a typo.
//
// Runs last of the three, so its richer fields — listing_date above all, which
// neither exchange supplies — win the upsert.
// ---------------------------------------------------------------------------

const CHITTORGARH_REPORT = 'https://webnodejs.chittorgarh.com/cloud/report/data-read/82/1';

const fetchChittorgarh: Provider = async (prior) => {
  // Reuse whatever symbol NSE or BSE already chose for the same issue this run.
  // 16 of 30 live issues carry no exchange identifier at all, so without this a
  // synthesised symbol would create a duplicate `ipos` row for each of them.
  const priorSymbols = new Map<string, string>();
  for (const record of prior) {
    if (!record.open_date) continue;
    priorSymbols.set(`${normalizeName(record.company_name)}|${record.open_date}`, record.symbol);
  }

  const today = new Date().toISOString().slice(0, 10);
  const [, month] = today.split('-');
  const byKey = new Map<string, IpoRecord>();
  const slugIndex = new Map<string, { symbol: string; open_date: string | null }>();

  for (const fy of financialYearsToFetch(today)) {
    const [year] = fy.split('-');
    const res = await fetch(`${CHITTORGARH_REPORT}/${Number(month)}/${year}/${fy}/0/all`, {
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) continue;

    const body = await res.json().catch(() => null);
    const rows: unknown[] = body?.reportTableData ?? [];

    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const record = chittorgarhRow(row, priorSymbols, today);
      if (!record) continue;

      // Two financial years can both list a March issue; keep one.
      byKey.set(`${record.symbol}|${record.open_date}`, record);

      const slug = String(row['~URLRewrite_Folder_Name'] ?? '').trim().toLowerCase();
      if (slug) slugIndex.set(slug, { symbol: record.symbol, open_date: record.open_date });
    }
  }

  const records = [...byKey.values()];
  if (records.length === 0) throw new Error('Chittorgarh returned no usable rows');
  return { provider: 'CHITTORGARH', records, slugIndex };
};

// ---------------------------------------------------------------------------
// upsert
// ---------------------------------------------------------------------------

async function upsert(client: SupabaseClient, records: IpoRecord[]): Promise<number> {
  // Rows without an open date can't participate in the (symbol, open_date)
  // unique index, so skip them rather than creating duplicates on every run.
  const usable = records.filter((r) => r.open_date);
  if (usable.length === 0) return 0;

  const { error } = await client.from('ipos').upsert(
    usable.map((r) => ({ ...r, created_by: null, last_synced_at: new Date().toISOString() })),
    { onConflict: 'symbol,open_date' },
  );
  if (error) throw error;
  return usable.length;
}

// ---------------------------------------------------------------------------
// GMP
//
// A different row shape, into a different table, with a different conflict
// target — so it runs outside the provider loop rather than making upsert()
// polymorphic. Its failure must never fail the sync: the IPO list is the
// product, GMP is a garnish.
// ---------------------------------------------------------------------------

const GMP_REPORT = 'https://webnodejs.investorgain.com/cloud/v2/report/data-read/331/1';

async function fetchGmp(): Promise<GmpReading[]> {
  const runIso = new Date().toISOString();
  const today = runIso.slice(0, 10);
  const [year, month] = today.split('-');
  const fy = financialYearsToFetch(today)[0];

  const res = await fetch(`${GMP_REPORT}/${Number(month)}/${year}/${fy}/0/all`, {
    headers: BROWSER_HEADERS,
  });
  if (!res.ok) throw new Error(`GMP feed responded ${res.status}`);

  const body = await res.json().catch(() => null);
  const rows: unknown[] = body?.reportTableData ?? [];

  const readings = rows
    .map((raw) => gmpRow(raw as Record<string, unknown>, runIso))
    .filter((r): r is GmpReading => r !== null);

  if (readings.length === 0) throw new Error('GMP feed returned no usable rows');
  return readings;
}

function windowAround(days: number): { from: string; to: string } {
  const now = Date.now();
  return {
    from: new Date(now - days * 86_400_000).toISOString().slice(0, 10),
    to: new Date(now + days * 86_400_000).toISOString().slice(0, 10),
  };
}

/** Every synced IPO near today, as the indexes the matching ladder needs. */
async function loadIpoIndexes(client: SupabaseClient) {
  const { from, to } = windowAround(MATCH_WINDOW_DAYS);
  const { data, error } = await client
    .from('ipos')
    .select('id, symbol, company_name, open_date')
    .is('created_by', null)
    .gte('open_date', from)
    .lte('open_date', to);
  if (error) throw error;
  return buildIpoIndexes(data ?? []);
}

async function writeGmp(
  client: SupabaseClient,
  readings: GmpReading[],
  slugIndex: Map<string, { symbol: string; open_date: string | null }>,
): Promise<number> {
  const indexes = await loadIpoIndexes(client);

  const rows = readings.map((reading) => ({
    ...reading,
    ipo_id: resolveIpoId(reading, slugIndex, indexes),
    synced_at: new Date().toISOString(),
  }));

  const { error } = await client
    .from('ipo_gmp')
    .upsert(rows, { onConflict: 'provider,provider_slug,observed_at', ignoreDuplicates: true });
  if (error) throw error;

  return rows.length;
}

/**
 * Re-try readings that arrived before their IPO did. Done in TypeScript rather
 * than SQL so it reuses the one tested normalizeName, instead of duplicating
 * the normalisation rules in PL/pgSQL where they would quietly drift.
 */
async function backfillGmp(
  client: SupabaseClient,
  slugIndex: Map<string, { symbol: string; open_date: string | null }>,
): Promise<number> {
  const { from } = windowAround(MATCH_WINDOW_DAYS);
  const { data, error } = await client
    .from('ipo_gmp')
    .select('id, provider, provider_slug, company_name, open_date')
    .is('ipo_id', null)
    .gte('open_date', from);
  if (error) throw error;
  if (!data || data.length === 0) return 0;

  const indexes = await loadIpoIndexes(client);
  let repaired = 0;

  for (const row of data) {
    const id = resolveIpoId(row as unknown as GmpReading, slugIndex, indexes);
    if (!id) continue;
    const { error: updateError } = await client
      .from('ipo_gmp')
      .update({ ipo_id: id })
      .eq('id', row.id);
    if (!updateError) repaired += 1;
  }

  return repaired;
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

type Outcome = { provider: string; ok: boolean; rows: number; message?: string };

Deno.serve(async () => {
  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Named, rather than derived from function identity — with three providers,
  // `provider === fetchNse ? 'NSE' : 'BSE'` would log every Chittorgarh failure
  // as BSE and make the app's staleness banner blame the wrong scraper.
  const providers: readonly (readonly [string, Provider])[] = [
    ['NSE', fetchNse],
    ['BSE', fetchBse],
    ['CHITTORGARH', fetchChittorgarh],
  ];

  const outcomes: Outcome[] = [];
  const prior: IpoRecord[] = [];
  let slugIndex = new Map<string, { symbol: string; open_date: string | null }>();

  for (const [name, provider] of providers) {
    try {
      const result = await provider(prior);
      const rows = await upsert(client, result.records);
      prior.push(...result.records);
      if (result.slugIndex) slugIndex = result.slugIndex;
      outcomes.push({ provider: name, ok: true, rows });
      await client.from('sync_log').insert({ provider: name, ok: true, rows_upserted: rows });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      outcomes.push({ provider: name, ok: false, rows: 0, message });
      await client.from('sync_log').insert({
        provider: name,
        ok: false,
        rows_upserted: 0,
        message,
      });
    }
  }

  // Computed before the GMP leg is folded in, so a dead grey-market feed can
  // never turn a healthy IPO sync into an HTTP 502.
  const anyOk = outcomes.some((o) => o.ok);

  const gmp: Outcome = { provider: 'CHITTORGARH_GMP', ok: false, rows: 0 };
  try {
    const readings = await fetchGmp();
    gmp.rows = await writeGmp(client, readings, slugIndex);
    gmp.rows += await backfillGmp(client, slugIndex);
    gmp.ok = true;
  } catch (e) {
    gmp.message = e instanceof Error ? e.message : String(e);
  }
  outcomes.push(gmp);
  await client.from('sync_log').insert({
    provider: gmp.provider,
    ok: gmp.ok,
    rows_upserted: gmp.rows,
    message: gmp.message ?? null,
  });

  // Roll IPOs forward through their lifecycle regardless of whether the fetch
  // worked, so the app's Open/Closed tabs stay correct even when a provider is
  // down for days.
  //
  // The `created_by is null` filters are load-bearing: without them a scheduled
  // sync silently rewrites the status of IPOs a user entered by hand, which
  // breaks the promise made at the top of this file.
  const today = new Date().toISOString().slice(0, 10);
  await client
    .from('ipos')
    .update({ status: 'OPEN' })
    .is('created_by', null)
    .lte('open_date', today)
    .gte('close_date', today)
    .eq('status', 'UPCOMING');
  await client
    .from('ipos')
    .update({ status: 'CLOSED' })
    .is('created_by', null)
    .lt('close_date', today)
    .in('status', ['UPCOMING', 'OPEN']);

  return new Response(JSON.stringify({ ok: anyOk, outcomes }, null, 2), {
    status: anyOk ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
});
