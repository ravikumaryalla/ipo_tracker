/**
 * Pure parsing, decision, and token-encryption logic for MUFG Intime's
 * allotment-status query, mirroring parse.ts's KFintech equivalent —
 * deliberately free of `Deno.*` and network calls (Web Crypto and
 * TextEncoder/btoa are standard globals in both Deno and Node, so this stays
 * testable under Node without pulling in any library).
 *
 * `IPO.aspx/SearchOnPan` takes a `token` field the site's own client-side JS
 * (js/custom.js's public-issues.html, function encVal) produces by AES-128-CBC
 * encrypting a session token (from IPO.aspx/generateToken) with a fixed,
 * publicly-visible key and IV baked into that same client script:
 * '8080808080808080' for both. That key isn't a secret held server-side —
 * it ships in the page every visitor's browser already loads — so
 * reproducing it here is replicating the site's own public client, not
 * bypassing anything. Confirmed live on 2026-08-19 that the token field
 * isn't actually checked against a solved captcha: the page's own captcha-
 * character comparison is commented out in its source, and a stale token
 * from an unrelated session was accepted.
 *
 * `IPO.aspx/SearchOnPan` returns `{"d": "<xml string>"}`, an ADO.NET
 * NewDataSet serialised as a string — same shape as GetDetails in
 * sync-ipos/mufg.ts. A match is a single `<Table>` row carrying `ALLOT`
 * (shares allotted, numeric — unlike Bigshare's free-text status field) and
 * `SHARES` (shares applied). No match is a `<Table1><Msg>...</Msg></Table1>`
 * row instead.
 */

export type AllotmentOutcome = 'ALLOTTED' | 'PARTIAL' | 'NOT_ALLOTTED';

/** One application MUFG has on file against the queried (company, PAN). */
export type MufgAllotmentMatch = {
  dpClientId: string | null;
  applicantName: string | null;
  sharesApplied: number | null;
  sharesAllotted: number;
};

function tagText(row: string, tag: string): string | null {
  const m = row.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

function toNumberOrNull(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * MUFG's query-endpoint JSON body → a match, or null when there's nothing on
 * file yet (the confirmed live `<Table1><Msg>` shape) or the response
 * doesn't parse as expected — a malformed response is worse to guess at than
 * to treat as "not out yet".
 */
export function parseMufgAllotmentBody(body: unknown): MufgAllotmentMatch | null {
  const xml = typeof (body as { d?: unknown })?.d === 'string' ? (body as { d: string }).d : '';
  if (!xml) return null;

  // Table1 (a message row) means nothing's on file — checked before Table
  // since a malformed/partial response could carry neither.
  if (/<Table1>/.test(xml)) return null;

  const tableMatch = xml.match(/<Table>([\s\S]*?)<\/Table>/);
  if (!tableMatch) return null;

  const row = tableMatch[1];
  const allotted = toNumberOrNull(tagText(row, 'ALLOT'));
  if (allotted == null) return null;

  return {
    dpClientId: tagText(row, 'DPCLITID'),
    applicantName: tagText(row, 'NAME1'),
    sharesApplied: toNumberOrNull(tagText(row, 'SHARES')),
    sharesAllotted: allotted,
  };
}

/** Numeric, unlike Bigshare's text status — same shape as parse.ts's statusFor. */
export function mufgStatusFor(match: MufgAllotmentMatch, fallbackApplied: number): AllotmentOutcome {
  if (match.sharesAllotted <= 0) return 'NOT_ALLOTTED';
  const applied = match.sharesApplied ?? fallbackApplied;
  return match.sharesAllotted < applied ? 'PARTIAL' : 'ALLOTTED';
}

const AES_KEY_IV = new TextEncoder().encode('8080808080808080');

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Reproduces encVal() from MUFG's own public-issues.html: AES-128-CBC,
 * PKCS7 padding (Web Crypto's AES-CBC always pads this way, matching
 * CryptoJS's default), the fixed key/IV described in this file's header.
 */
export async function encryptMufgToken(rawToken: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', AES_KEY_IV, { name: 'AES-CBC' }, false, [
    'encrypt',
  ]);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: AES_KEY_IV },
    key,
    new TextEncoder().encode(rawToken),
  );
  return base64FromBytes(new Uint8Array(cipherBuffer));
}
