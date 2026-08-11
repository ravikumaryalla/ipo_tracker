/**
 * KFintech allotment-status lookup (https://ipostatus.kfintech.com).
 *
 * This is the one PAN-bearing call in the app that talks to a third party
 * directly rather than through Supabase, so it deliberately lives outside
 * lib/db: nothing here touches the database, and nothing in lib/db imports a
 * network fetcher. lib/db/allotment.ts is the only caller, and it is the one
 * place PAN gets decrypted before being handed to this module.
 *
 * The request shape below was captured from KFintech's own frontend (their
 * public bundle at ipostatus.kfintech.com/static/js/main.<hash>.js calls this
 * exact endpoint with these exact header names) — it is not documented and
 * KFintech can change it without notice. The endpoint also supports
 * Application No. and DP/Client ID lookups (`type=appno` with
 * `reqparam: "<applicationNo>|<pan>"`, and `type=dpclid` with
 * `reqparam: "<NSDL 'IN'-prefixed or CDSL id>"`), but only the PAN path is
 * implemented here since that's the field the app already stores encrypted.
 */

const QUERY_URL = 'https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query?type=pan';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

/** One application KFintech has on file against the queried PAN. */
export type KfintechAllotmentMatch = {
  applicationNo: string | null;
  dpClientId: string | null;
  applicantName: string | null;
  sharesApplied: number | null;
  sharesAllotted: number;
};

export type KfintechAllotmentResult =
  | { found: true; matches: KfintechAllotmentMatch[] }
  | { found: false };

type QueryRow = {
  Appln_No?: unknown;
  DP_CLID?: unknown;
  Name?: unknown;
  App_Shares?: unknown;
  All_Shares?: unknown;
};

function toNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toRow(raw: QueryRow): KfintechAllotmentMatch {
  return {
    applicationNo: raw.Appln_No != null ? String(raw.Appln_No) : null,
    dpClientId: raw.DP_CLID != null ? String(raw.DP_CLID) : null,
    applicantName: raw.Name != null ? String(raw.Name) : null,
    sharesApplied: toNumberOrNull(raw.App_Shares),
    sharesAllotted: toNumberOrNull(raw.All_Shares) ?? 0,
  };
}

/**
 * Query allotment status for one PAN against one KFintech-registered issue.
 *
 * `companyId` is `ipos.kfintech_company_id`, resolved ahead of time by the
 * sync-ipos company-list matcher — this function never guesses which issue
 * it's talking to.
 *
 * Throws on anything that isn't a definitive answer (network failure, rate
 * limiting, KFintech's own 5xx codes) so the caller never mistakes "couldn't
 * check" for "checked, not allotted." A clean "no application found" comes
 * back as `{ found: false }`, not an error.
 */
export async function checkKfintechAllotment(
  companyId: string,
  pan: string,
): Promise<KfintechAllotmentResult> {
  const res = await fetch(QUERY_URL, {
    headers: { ...BROWSER_HEADERS, reqparam: pan, client_id: companyId },
  });

  if (res.status === 404) return { found: false };
  if (res.status === 429) throw new Error('KFintech is rate-limiting allotment checks — try again shortly.');
  if (!res.ok) throw new Error(`KFintech allotment check responded ${res.status}`);

  const body = await res.json().catch(() => null);
  const rows: unknown[] = Array.isArray(body?.data) ? body.data : [];
  if (rows.length === 0) return { found: false };

  return { found: true, matches: rows.map((row) => toRow(row as QueryRow)) };
}
