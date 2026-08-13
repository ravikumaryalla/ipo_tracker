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
 * exactly that reason, with one narrow, intentional exception:
 * `syncKfintechCompanies` also matches against manually-added IPOs and may
 * write `kfintech_company_id`/`registrar`/`registrar_url` onto one. That's
 * safe to exempt because it only ever sets those three additive fields, never
 * anything the user actually typed (name, dates, price band, lot size), and
 * only on an unambiguous exact company-name match — a manually-added IPO
 * would otherwise never get a KFintech match at all.
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
  ipogyaniGmpRow,
  type IpogyaniIpo,
  ipogyaniIpoRow,
  ipogyaniSlug,
  priorIndex,
  type RegistrarAssignment,
  registrarAssignments,
} from './ipogyani.ts';
import {
  buildIpoIndexes,
  type GmpReading,
  type IpoIndexes,
  type IpoRecord,
  ipowatchGmpRow,
  type IpowatchGmpRow,
  ipowatchIpoRow,
  type IpowatchListingRow,
  normalizeName,
  parseDate,
  parseIpowatchGmpTable,
  parseIpowatchListingTable,
  parseKfintechCompanies,
  parsePriceBand,
  resolveIpoId,
  resolveKfintechCompanyMatch,
  slugFromPath,
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
  /**
   * Registrars this provider learned, applied by applyRegistrars after the
   * loop. Carried here rather than on IpoRecord so the shared upsert cannot
   * null them out — see registrarAssignments in ipogyani.ts.
   */
  registrars?: RegistrarAssignment[];
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
        allotment_date: null,
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
      allotment_date: null,
      source: 'BSE',
    });
  }

  if (records.length === 0) throw new Error('BSE returned no usable rows');
  return { provider: 'BSE', records };
};

// ---------------------------------------------------------------------------
// provider: ipowatch.in
//
// No public API; these are the same server-rendered pages a browser loads.
// Fetched as plain HTML and walked with a regex table parser (see parse.ts) —
// confirmed the tables need no client-side JS to be complete: the listing
// page's own DataTables footer reports "Showing N of N entries" for every
// row, so a plain fetch already carries the full table.
//
// SME issues are dropped in parse.ts (ipowatchIpoRow/ipowatchGmpRow).
//
// This provider USED TO also fetch every Mainboard IPO's own page, purely for
// lot_size, issue_size_cr and allotment_date. That fan-out is gone: ipogyani
// returns all three for every Mainboard issue inside one 39 KB JSON response,
// where these pages cost 400-800 KB each. Together with the 891 KB GMP page
// and the 548 KB listing page, a healthy ipowatch was pushing 5-9 MB of HTML
// through the regex parsers per run and killing the worker outright
// (WORKER_RESOURCE_LIMIT) — which took the working ipogyani legs down with it.
// parseIpowatchIpoDetail and mergeIpowatchDetail are left in parse.ts, tested,
// should that fallback ever be wanted back.
//
// The listing-date page is fetched separately from the GMP page purely to
// attach listing_date and exchange symbols by company name; a failure there
// degrades to null listing_date/symbols rather than failing the whole
// provider, since the GMP page alone is enough to keep the IPO list current.
//
// Runs after the two exchanges, so its richer fields — listing_date above all,
// which neither exchange supplies — beat theirs in the upsert. It no longer
// runs last: ipogyani below carries more still, and fills any gap this one
// leaves rather than overwriting what it found.
// ---------------------------------------------------------------------------

const IPOWATCH_GMP_URL = 'https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/';
const IPOWATCH_LISTING_URL = 'https://ipowatch.in/new-ipo-listing-today-ipo-listing-date/';

/**
 * The GMP page, fetched at most once per invocation.
 *
 * Two legs need it — the IPO-list provider and the GMP feed — and they used to
 * fetch it separately so they could fail independently. That page is 891 KB,
 * so doing it twice meant 1.8 MB downloaded and two full regex walks over it,
 * which is what pushed this function past the Edge runtime's compute budget
 * (WORKER_RESOURCE_LIMIT) once ipowatch came back from an outage.
 *
 * Sharing the promise keeps the independence that mattered: both legs still
 * see the same failure and each still records its own sync_log row. Reset per
 * request rather than given a TTL, so a warm isolate can never serve one run's
 * page to the next.
 */
let ipowatchGmpHtml: Promise<string> | null = null;

function fetchIpowatchGmpHtml(): Promise<string> {
  if (!ipowatchGmpHtml) {
    ipowatchGmpHtml = (async () => {
      const res = await fetch(IPOWATCH_GMP_URL, {
        headers: { ...BROWSER_HEADERS, Accept: 'text/html' },
      });
      if (!res.ok) throw new Error(`ipowatch GMP page responded ${res.status}`);
      return await res.text();
    })();
  }
  return ipowatchGmpHtml;
}

async function fetchIpowatchListingByName(): Promise<Map<string, IpowatchListingRow>> {
  try {
    const res = await fetch(IPOWATCH_LISTING_URL, {
      headers: { ...BROWSER_HEADERS, Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`ipowatch listing page responded ${res.status}`);
    const html = await res.text();

    // Mainboard and SME ship as two separate TablePress tables.
    const rows = [
      ...parseIpowatchListingTable(html, 'tablepress-30'),
      ...parseIpowatchListingTable(html, 'tablepress-31'),
    ];

    const byName = new Map<string, IpowatchListingRow>();
    for (const row of rows) byName.set(normalizeName(row.company_name), row);
    return byName;
  } catch {
    return new Map();
  }
}

const fetchIpowatch: Provider = async (prior) => {
  // Reuse whatever symbol NSE or BSE already chose for the same issue this run.
  // Most live issues carry no exchange identifier at all, so without this a
  // synthesised symbol would create a duplicate `ipos` row for each of them.
  const priorSymbols = new Map<string, string>();
  for (const record of prior) {
    if (!record.open_date) continue;
    priorSymbols.set(`${normalizeName(record.company_name)}|${record.open_date}`, record.symbol);
  }

  const today = new Date().toISOString().slice(0, 10);

  const [gmpHtml, listingByName] = await Promise.all([
    fetchIpowatchGmpHtml(),
    fetchIpowatchListingByName(),
  ]);
  const gmpRows = parseIpowatchGmpTable(gmpHtml);

  const base: { row: IpowatchGmpRow; record: IpoRecord }[] = [];
  for (const row of gmpRows) {
    const record = ipowatchIpoRow(row, listingByName, priorSymbols, today);
    if (record) base.push({ row, record });
  }

  const byKey = new Map<string, IpoRecord>();
  const slugIndex = new Map<string, { symbol: string; open_date: string | null }>();

  // lot_size, issue_size_cr and allotment_date stay null here — ipogyani
  // supplies them from its list response, so no per-IPO page is fetched. See
  // the note above the URLs.
  base.forEach(({ row, record }) => {
    byKey.set(`${record.symbol}|${record.open_date}`, record);

    const slug = slugFromPath(row.url);
    if (slug) slugIndex.set(slug, { symbol: record.symbol, open_date: record.open_date });
  });

  const records = [...byKey.values()];
  if (records.length === 0) throw new Error('ipowatch returned no usable rows');
  return { provider: 'IPOWATCH', records, slugIndex };
};

// ---------------------------------------------------------------------------
// provider: ipogyani.com
//
// Also undocumented, but JSON rather than HTML: /api/ipos is the endpoint the
// site's own pages call, and one 39 KB response carries every field the three
// ipowatch fetches above have to reassemble — price band, lot size, issue
// size, all four dates, GMP with a real ISO timestamp, and the subscription
// figures ipowatch never quoted at all. No parsing, no per-IPO detail fetch,
// no date-format guessing; see ipogyani.ts for the mapping.
//
// Runs last of the four, so the fields it has and the exchanges do not —
// listing_date and allotment_date above all — win the upsert. Running last is
// only safe because ipogyaniIpoRow folds the earlier providers' record into
// its own and never overwrites a populated field with a null.
//
// ipowatch is deliberately kept alongside it rather than replaced: two
// independent grey-market feeds mean a redesign on either side degrades the
// chart instead of emptying it.
// ---------------------------------------------------------------------------

const IPOGYANI_API = 'https://ipogyani.com/api/ipos';

async function fetchIpogyaniApi(): Promise<IpogyaniIpo[]> {
  const res = await fetch(IPOGYANI_API, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`ipogyani API responded ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) throw new Error('ipogyani API did not return an array');
  return body as IpogyaniIpo[];
}

const fetchIpogyani: Provider = async (prior) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await fetchIpogyaniApi();

  // ipogyani publishes no exchange trading symbol and does not say which
  // exchange a "Mainboard" issue lists on, so both come from whatever NSE, BSE
  // or ipowatch already wrote for the same company this run.
  const priorByName = priorIndex(prior);

  const byKey = new Map<string, IpoRecord>();
  const slugIndex = new Map<string, { symbol: string; open_date: string | null }>();

  for (const row of rows) {
    const record = ipogyaniIpoRow(row, priorByName, today);
    if (!record) continue;
    byKey.set(`${record.symbol}|${record.open_date}`, record);
    const slug = ipogyaniSlug(row);
    if (slug) slugIndex.set(slug, { symbol: record.symbol, open_date: record.open_date });
  }

  const records = [...byKey.values()];
  if (records.length === 0) throw new Error('ipogyani returned no usable rows');
  return {
    provider: 'IPOGYANI',
    records,
    slugIndex,
    registrars: registrarAssignments(rows, records),
  };
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
//
// Two feeds write here. They share `ipo_gmp` without colliding because its
// unique index is (provider, provider_slug, observed_at) and they disagree on
// all three: different provider names, different slugs for the same issue
// ('behari-lal-ipo' vs 'behari-lal-engineering-ipo'), and different update
// stamps. Each is fetched and logged separately so a redesign on one side
// leaves the other's series intact and the app's banner can name the culprit.
// ---------------------------------------------------------------------------

async function fetchIpogyaniGmp(): Promise<GmpReading[]> {
  // Refetched rather than threaded through from fetchIpogyani, for the same
  // reason fetchGmp refetches the ipowatch page: the two legs must be able to
  // fail independently, and this response is 39 KB of JSON.
  const readings = (await fetchIpogyaniApi())
    .map(ipogyaniGmpRow)
    .filter((r): r is GmpReading => r !== null);

  if (readings.length === 0) throw new Error('ipogyani API returned no usable GMP rows');
  return readings;
}

async function fetchGmp(): Promise<GmpReading[]> {
  const runIso = new Date().toISOString();
  const rows = parseIpowatchGmpTable(await fetchIpowatchGmpHtml());

  const readings = rows
    .map((row) => ipowatchGmpRow(row, runIso))
    .filter((r): r is GmpReading => r !== null);

  if (readings.length === 0) throw new Error('ipowatch GMP table returned no usable rows');
  return readings;
}

function windowAround(days: number): { from: string; to: string } {
  const now = Date.now();
  return {
    from: new Date(now - days * 86_400_000).toISOString().slice(0, 10),
    to: new Date(now + days * 86_400_000).toISOString().slice(0, 10),
  };
}

/**
 * Every synced IPO near today, as the indexes the matching ladder needs.
 *
 * `includeManual` widens this to also cover IPOs a user added by hand — only
 * `syncKfintechCompanies` passes it, since that pass writes nothing a user
 * actually typed (see the file header). GMP attachment (`writeGmp`/
 * `backfillGmp`) never does, staying scoped to auto-synced rows.
 */
async function loadIpoIndexes(client: SupabaseClient, options: { includeManual?: boolean } = {}) {
  const { from, to } = windowAround(MATCH_WINDOW_DAYS);
  let query = client
    .from('ipos')
    .select('id, symbol, company_name, open_date')
    .gte('open_date', from)
    .lte('open_date', to);
  if (!options.includeManual) query = query.is('created_by', null);
  const { data, error } = await query;
  if (error) throw error;
  return buildIpoIndexes(data ?? []);
}

async function writeGmp(
  client: SupabaseClient,
  readings: GmpReading[],
  slugIndex: Map<string, { symbol: string; open_date: string | null }>,
  indexes: IpoIndexes,
): Promise<number> {
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
  indexes: IpoIndexes,
): Promise<number> {
  const { from } = windowAround(MATCH_WINDOW_DAYS);
  const { data, error } = await client
    .from('ipo_gmp')
    .select('id, provider, provider_slug, company_name, open_date')
    .is('ipo_id', null)
    .gte('open_date', from);
  if (error) throw error;
  if (!data || data.length === 0) return 0;

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
// registrar
//
// Written as narrow updates after the provider loop rather than as a field on
// IpoRecord, because the upsert writes whole rows per provider: NSE runs first
// and knows no registrar, so a registrar on IpoRecord would be nulled on every
// issue ipogyani does not also carry, and nothing would restore it —
// syncKfintechCompanies now runs once ever rather than every tick.
// ---------------------------------------------------------------------------

async function applyRegistrars(
  client: SupabaseClient,
  assignments: RegistrarAssignment[],
  indexes: IpoIndexes,
): Promise<number> {
  if (assignments.length === 0) return 0;

  // Grouped by registrar, not written one row at a time. A handful of
  // registrars handle every issue on the book — 11 live IPOs resolved to just
  // three — so this is three `in (…)` updates rather than eleven round trips.
  // That distinction is not cosmetic: the per-row version tipped the whole
  // function over the Edge runtime's compute limit (WORKER_RESOURCE_LIMIT).
  const byRegistrar = new Map<string, { name: string; url: string | null; ids: string[] }>();

  for (const assignment of assignments) {
    const id = indexes.bySymbolOpen.get(
      `${assignment.symbol.toUpperCase()}|${assignment.open_date}`,
    );
    if (!id) continue;

    const key = `${assignment.name}|${assignment.url ?? ''}`;
    const group = byRegistrar.get(key);
    if (group) group.ids.push(id);
    else byRegistrar.set(key, { name: assignment.name, url: assignment.url, ids: [id] });
  }

  let updated = 0;
  for (const { name, url, ids } of byRegistrar.values()) {
    const { error } = await client
      .from('ipos')
      .update({ registrar: name, registrar_url: url })
      .in('id', ids)
      // KFintech listing an issue in its own allotment dropdown is direct
      // evidence of who the registrar is; ipogyani is a third party reporting
      // it. Where they disagree, the evidence wins.
      .is('kfintech_company_id', null)
      // Load-bearing, and deliberately unlike syncKfintechCompanies, which
      // exempts itself from this filter (see the file header). That pass only
      // writes fields a user never types. `registrar` is one they do — it is a
      // field on the manual-add form — so this pass must never touch their row.
      .is('created_by', null);
    if (!error) updated += ids.length;
  }

  return updated;
}

// ---------------------------------------------------------------------------
// KFintech allotment-status company list
//
// Public data only — no PAN involved. This just resolves which `ipos` rows
// are KFintech-registered issues and records the internal `clientId` their
// allotment-status API needs, so the app can query allotment status on-device
// without rediscovering that id per check. See lib/registrars/kfintech.ts for
// the PAN-bearing query itself, which never runs here.
// ---------------------------------------------------------------------------

const KFINTECH_BASE = 'https://ipostatus.kfintech.com';

async function fetchKfintechCompanies() {
  const homepage = await fetch(`${KFINTECH_BASE}/`, { headers: BROWSER_HEADERS });
  if (!homepage.ok) throw new Error(`KFintech homepage responded ${homepage.status}`);
  const html = await homepage.text();

  // KFintech has served this as both "/static/js/main.<hash>.js" and, since
  // 2026-08, "./static/js/main.<hash>.js" — tolerate either leading form and
  // always rebuild the URL with a single slash rather than trusting whichever
  // one shows up.
  const scriptMatch = html.match(/src="\.?\/?(static\/js\/main\.[a-z0-9]+\.js)"/);
  if (!scriptMatch) throw new Error('KFintech homepage did not reference a main.<hash>.js bundle');

  const bundleRes = await fetch(`${KFINTECH_BASE}/${scriptMatch[1]}`, { headers: BROWSER_HEADERS });
  if (!bundleRes.ok) throw new Error(`KFintech bundle responded ${bundleRes.status}`);
  const bundle = await bundleRes.text();

  const companies = parseKfintechCompanies(bundle);
  if (companies.length === 0) throw new Error('KFintech bundle yielded no company entries');
  return companies;
}

// The registrar/company-id match barely changes once made, so the cron only
// needs to run it once ever, not on every scheduled tick — gate on whether a
// successful KFINTECH_MATCH row already exists rather than adding new state.
async function hasSucceededBefore(client: SupabaseClient, provider: string): Promise<boolean> {
  const { count } = await client
    .from('sync_log')
    .select('id', { count: 'exact', head: true })
    .eq('provider', provider)
    .eq('ok', true);
  return (count ?? 0) > 0;
}

async function syncKfintechCompanies(client: SupabaseClient): Promise<number> {
  const companies = await fetchKfintechCompanies();
  const indexes = await loadIpoIndexes(client, { includeManual: true });

  let matched = 0;
  for (const company of companies) {
    const id = resolveKfintechCompanyMatch(company, indexes);
    if (!id) continue;
    // Deliberately not `.is('created_by', null)` here — see the file header.
    const { error } = await client
      .from('ipos')
      .update({
        // Spelled the same way resolveRegistrar spells it — this column is
        // rendered straight into "Check allotment at …" on the IPO screen, and
        // two spellings would show up as two different registrars.
        registrar: 'KFintech',
        registrar_url: `${KFINTECH_BASE}/`,
        kfintech_company_id: company.clientId,
      })
      .eq('id', id);
    if (!error) matched += 1;
  }

  return matched;
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

type Outcome = { provider: string; ok: boolean; rows: number; message?: string };

Deno.serve(async (req) => {
  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Isolates are reused between invocations, so the per-request page cache has
  // to be cleared here rather than trusted to be empty.
  ipowatchGmpHtml = null;

  // The app calls this on demand (from the "Check status" button, when an
  // IPO has no kfintech_company_id yet) wanting just a fast KFintech re-match
  // attempt, not the full multi-provider scrape the cron runs. `req.json()`
  // throws on an empty body (the cron invokes with none), so default to `{}`.
  const body = await req.json().catch(() => ({}));
  if (body?.onlyKfintech === true) {
    const outcome: Outcome = { provider: 'KFINTECH_MATCH', ok: false, rows: 0 };
    try {
      outcome.rows = await syncKfintechCompanies(client);
      outcome.ok = true;
    } catch (e) {
      outcome.message = e instanceof Error ? e.message : String(e);
    }
    await client.from('sync_log').insert({
      provider: outcome.provider,
      ok: outcome.ok,
      rows_upserted: outcome.rows,
      message: outcome.message ?? null,
    });
    return new Response(JSON.stringify({ ok: outcome.ok, outcomes: [outcome] }, null, 2), {
      status: outcome.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Named, rather than derived from function identity — with four providers,
  // `provider === fetchNse ? 'NSE' : 'BSE'` would log every ipowatch failure as
  // BSE and make the app's staleness banner blame the wrong scraper.
  //
  // Order is load-bearing: each provider sees what the earlier ones produced,
  // and the last one's fields win the upsert. The exchanges go first because
  // they are the only source of a real trading symbol; ipogyani goes last
  // because it carries the most fields.
  const providers: readonly (readonly [string, Provider])[] = [
    ['NSE', fetchNse],
    ['BSE', fetchBse],
    ['IPOWATCH', fetchIpowatch],
    ['IPOGYANI', fetchIpogyani],
  ];

  const outcomes: Outcome[] = [];
  const prior: IpoRecord[] = [];
  // Merged across providers, not replaced by the last one to return: both
  // ipowatch and ipogyani supply a slug index, and each GMP feed needs its own
  // slugs present for the slug→symbol rung of resolveIpoId. Their slug
  // namespaces do not overlap.
  const slugIndex = new Map<string, { symbol: string; open_date: string | null }>();
  const registrars: RegistrarAssignment[] = [];

  for (const [name, provider] of providers) {
    try {
      const result = await provider(prior);
      const rows = await upsert(client, result.records);
      prior.push(...result.records);
      if (result.slugIndex) for (const [k, v] of result.slugIndex) slugIndex.set(k, v);
      if (result.registrars) registrars.push(...result.registrars);
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

  // Loaded once and shared by every pass below. All four consumers run after
  // the provider loop, so they all want the same post-upsert snapshot — and
  // reloading it per pass was four identical round trips against the same
  // 45-day window.
  const indexes = await loadIpoIndexes(client);

  const registrar: Outcome = { provider: 'REGISTRAR', ok: false, rows: 0 };
  try {
    registrar.rows = await applyRegistrars(client, registrars, indexes);
    registrar.ok = true;
  } catch (e) {
    registrar.message = e instanceof Error ? e.message : String(e);
  }
  outcomes.push(registrar);
  await client.from('sync_log').insert({
    provider: registrar.provider,
    ok: registrar.ok,
    rows_upserted: registrar.rows,
    message: registrar.message ?? null,
  });

  // Each feed is fetched, written and logged on its own so one dying leaves the
  // other's series intact. The backfill pass is shared — it re-tries every
  // unattached reading regardless of who wrote it — so it runs once, after
  // both, rather than being repeated per feed.
  const gmpFeeds: readonly (readonly [string, () => Promise<GmpReading[]>])[] = [
    ['IPOWATCH_GMP', fetchGmp],
    ['IPOGYANI_GMP', fetchIpogyaniGmp],
  ];

  for (const [name, fetchReadings] of gmpFeeds) {
    const gmp: Outcome = { provider: name, ok: false, rows: 0 };
    try {
      gmp.rows = await writeGmp(client, await fetchReadings(), slugIndex, indexes);
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
  }

  const backfill: Outcome = { provider: 'GMP_BACKFILL', ok: false, rows: 0 };
  try {
    backfill.rows = await backfillGmp(client, slugIndex, indexes);
    backfill.ok = true;
  } catch (e) {
    backfill.message = e instanceof Error ? e.message : String(e);
  }
  outcomes.push(backfill);
  await client.from('sync_log').insert({
    provider: backfill.provider,
    ok: backfill.ok,
    rows_upserted: backfill.rows,
    message: backfill.message ?? null,
  });

  const kfintech: Outcome = { provider: 'KFINTECH_MATCH', ok: false, rows: 0 };
  if (await hasSucceededBefore(client, 'KFINTECH_MATCH')) {
    kfintech.ok = true;
    kfintech.message = 'skipped: already synced once';
  } else {
    try {
      kfintech.rows = await syncKfintechCompanies(client);
      kfintech.ok = true;
    } catch (e) {
      kfintech.message = e instanceof Error ? e.message : String(e);
    }
  }
  outcomes.push(kfintech);
  await client.from('sync_log').insert({
    provider: kfintech.provider,
    ok: kfintech.ok,
    rows_upserted: kfintech.rows,
    message: kfintech.message ?? null,
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
