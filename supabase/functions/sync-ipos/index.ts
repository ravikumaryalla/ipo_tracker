/**
 * sync-ipos — pulls the current and upcoming IPO list into public.ipos.
 *
 * A WORD OF WARNING, because it matters for how you read failures here:
 * neither NSE nor BSE publishes a documented public IPO API. These are the
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
 * shared `ipos` table (created_by IS NULL) and `sync_log` — it must never touch
 * user data.
 *
 * Deploy:  supabase functions deploy sync-ipos
 * Invoke:  supabase functions invoke sync-ipos
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json, text/plain, */*',
};

type IpoRecord = {
  symbol: string;
  company_name: string;
  exchange: string;
  segment: 'MAINBOARD' | 'SME';
  status: 'UPCOMING' | 'OPEN' | 'CLOSED' | 'LISTED';
  open_date: string | null;
  close_date: string | null;
  price_band_min: number | null;
  price_band_max: number | null;
  lot_size: number | null;
  issue_size_cr: number | null;
  source: string;
};

type ProviderResult = { provider: string; records: IpoRecord[] };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** NSE dates look like "09-Aug-2026". Anything unparseable becomes null. */
function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  const dmy = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dmy) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(dmy[2].toLowerCase());
    if (month >= 0) {
      return `${dmy[3]}-${String(month + 1).padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** "₹ 100 - 105" / "100-105" / "105" → [100, 105]. */
function parsePriceBand(value: unknown): [number | null, number | null] {
  if (typeof value !== 'string') return [null, null];
  const numbers = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return [null, null];
  const min = Number(numbers[0]);
  const max = numbers.length > 1 ? Number(numbers[1]) : min;
  return [min, max];
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const n = Number(value.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function statusFor(open: string | null, close: string | null): IpoRecord['status'] {
  const today = new Date().toISOString().slice(0, 10);
  if (open && today < open) return 'UPCOMING';
  if (close && today > close) return 'CLOSED';
  if (open && close) return 'OPEN';
  return 'UPCOMING';
}

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

async function fetchNse(): Promise<ProviderResult> {
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
}

// ---------------------------------------------------------------------------
// provider: BSE
// ---------------------------------------------------------------------------

async function fetchBse(): Promise<ProviderResult> {
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
      price_band_min: toNumber(row.Issue_Price_From ?? row.PriceFrom),
      price_band_max: toNumber(row.Issue_Price_To ?? row.PriceTo),
      lot_size: toNumber(row.Market_Lot ?? row.MarketLot),
      issue_size_cr: toNumber(row.Issue_Size),
      source: 'BSE',
    });
  }

  if (records.length === 0) throw new Error('BSE returned no usable rows');
  return { provider: 'BSE', records };
}

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
// entrypoint
// ---------------------------------------------------------------------------

Deno.serve(async () => {
  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const providers = [fetchNse, fetchBse];
  const outcomes: { provider: string; ok: boolean; rows: number; message?: string }[] = [];

  for (const provider of providers) {
    try {
      const { provider: name, records } = await provider();
      const rows = await upsert(client, records);
      outcomes.push({ provider: name, ok: true, rows });
      await client.from('sync_log').insert({ provider: name, ok: true, rows_upserted: rows });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const name = provider === fetchNse ? 'NSE' : 'BSE';
      outcomes.push({ provider: name, ok: false, rows: 0, message });
      await client.from('sync_log').insert({
        provider: name,
        ok: false,
        rows_upserted: 0,
        message,
      });
    }
  }

  const anyOk = outcomes.some((o) => o.ok);

  // Roll IPOs forward through their lifecycle regardless of whether the fetch
  // worked, so the app's Open/Closed tabs stay correct even when a provider is
  // down for days.
  const today = new Date().toISOString().slice(0, 10);
  await client.from('ipos').update({ status: 'OPEN' }).lte('open_date', today).gte('close_date', today).eq('status', 'UPCOMING');
  await client.from('ipos').update({ status: 'CLOSED' }).lt('close_date', today).in('status', ['UPCOMING', 'OPEN']);

  return new Response(JSON.stringify({ ok: anyOk, outcomes }, null, 2), {
    status: anyOk ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  });
});
