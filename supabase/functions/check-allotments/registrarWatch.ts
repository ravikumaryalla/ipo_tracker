/**
 * Detecting that an IPO's allotment has been published, without asking anyone's
 * allotment.
 *
 * Bigshare and MUFG both drive their allotment-status pages from a company list
 * that carries *only* the issues their lookup will currently answer for. An
 * issue appearing there is therefore the signal we want, and it is public — no
 * PAN, no application number, nothing user-specific. See the header comments on
 * supabase/functions/sync-ipos/bigshare.ts and mufg.ts, which reached the same
 * conclusion for a different purpose (resolving company ids).
 *
 * KFintech deliberately has no entry point here. Its dropdown is a full
 * directory baked into a JS bundle as `[{"clientId":…,"name":…}]` with no status
 * or date field, so presence there says nothing about whether results are out.
 * KFintech issues are simply never detected, and the app's own "Check" button
 * remains their only path.
 *
 * Pure by design — no imports, no `Deno.*`, no network — for the same reason
 * parse.ts is: it's the only part of this leg that can run under Node, so it's
 * the only part that gets tested. index.ts does the two fetches.
 *
 * The parsers and name-matching helpers below are ports, not imports, of their
 * namesakes in supabase/functions/sync-ipos/. The Supabase CLI's bundler roots
 * at supabase/ and parent-directory imports are not reliably included in the
 * deployed eszip — the exact constraint parse.ts:10-13 documents. Keeping the
 * matching rules character-identical to sync-ipos' matters: those rules are what
 * assigns bigshare_company_id/mufg_company_id today, and a watch that matched by
 * different rules would announce issues the on-demand check then can't find.
 */

/** One entry from a registrar's "currently answerable" company list. */
export type RegistrarCompany = { id: string; name: string };

// ---------------------------------------------------------------------------
// Bigshare — ported verbatim from supabase/functions/sync-ipos/bigshare.ts
// ---------------------------------------------------------------------------

const OPTION_RE = /<option\s+value="(\d+)">([^<]+)<\/option>/g;

/**
 * Bigshare's ipo_status.html carries the dropdown as plain
 * `<option value="id">NAME</option>` tags — but only for issues currently open
 * to a query. Every older issue is still in the markup, wrapped in an HTML
 * comment, so stripping comments first is all the notion of "current" this
 * needs.
 */
export function parseBigshareCompanies(html: string): RegistrarCompany[] {
  const ddlMatch = html.match(/<select[^>]*\bid="ddlCompany"[^>]*>([\s\S]*?)<\/select>/i);
  if (!ddlMatch) return [];

  const withoutComments = ddlMatch[1].replace(/<!--[\s\S]*?-->/g, '');

  const companies: RegistrarCompany[] = [];
  let match: RegExpExecArray | null;
  OPTION_RE.lastIndex = 0;
  while ((match = OPTION_RE.exec(withoutComments))) {
    const name = match[2].trim();
    if (name && name !== '--Select Company--') companies.push({ id: match[1], name });
  }
  return companies;
}

// ---------------------------------------------------------------------------
// MUFG — ported verbatim from supabase/functions/sync-ipos/mufg.ts
// ---------------------------------------------------------------------------

const TABLE_RE = /<Table>([\s\S]*?)<\/Table>/g;

function tagText(row: string, tag: string): string | null {
  const m = row.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

/**
 * `IPO.aspx/GetDetails` returns `{"d": "<xml string>"}` — an ADO.NET NewDataSet
 * serialised as a string, not real JSON. Walked with a regex for the same
 * reason the rest of this sync walks HTML that way: it is three or four rows,
 * and an XML library is not worth an Edge Function's cold start.
 */
export function parseMufgCompanies(xml: string): RegistrarCompany[] {
  const companies: RegistrarCompany[] = [];
  let match: RegExpExecArray | null;
  TABLE_RE.lastIndex = 0;
  while ((match = TABLE_RE.exec(xml))) {
    const id = tagText(match[1], 'company_id');
    // MUFG's own listing suffixes every name with " - IPO"; stripped here so it
    // matches the plain company_name every other provider gives us.
    const name = tagText(match[1], 'companyname')?.replace(/\s*-\s*IPO$/i, '').trim();
    if (id && name) companies.push({ id, name });
  }
  return companies;
}

/** Pull the XML string out of MUFG's `{"d": "<xml>"}` envelope. */
export function mufgXmlFromBody(body: unknown): string {
  const d = (body as { d?: unknown })?.d;
  return typeof d === 'string' ? d : '';
}

// ---------------------------------------------------------------------------
// name matching — ported from supabase/functions/sync-ipos/parse.ts
// ---------------------------------------------------------------------------

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

const NAME_NOISE = /\b(ltd|limited|pvt|private|india|indian|the|inc|corp|corporation|company|co)\b/g;

/**
 * The cleaned words of a company name — "Q & T Foods Private Limited IPO" and
 * "Q and T Foods Ltd." both become ['q', 'and', 't', 'foods']. Words rather
 * than one flattened key because the match rule below compares the first two
 * positionally.
 */
export function significantWords(name: unknown): string[] {
  const cleaned = decodeEntities(String(name ?? ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bipo\b/g, ' ')
    .replace(NAME_NOISE, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return cleaned ? cleaned.split(' ') : [];
}

/**
 * True if `a` and `b` are identical, or if their shared character prefix covers
 * all but the last couple of characters of the shorter one — enough to bridge a
 * registrar's spelling variant of the same word ("Jewellery" vs "Jewellers":
 * shared prefix "jeweller", 8 of 9 chars) without firing on genuinely different
 * short words ("steel" vs "steamers": shared prefix "ste", only 3 of 5).
 */
export function sharesLongPrefix(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  let common = 0;
  while (common < minLen && a[common] === b[common]) common++;
  return common >= 4 && common >= minLen - 2;
}

/**
 * The registrar-dropdown matching rule: first word exact, second word (when
 * both sides have one) only needs a long shared prefix. A registrar's own
 * listing carries no open date and no exchange symbol, and often spells the
 * tail of a name differently, so requiring the whole name to be identical left
 * real live issues permanently unmatched.
 */
export function firstTwoWordsMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a[0] !== b[0]) return false;
  if (a.length < 2 || b.length < 2) return true;
  return sharesLongPrefix(a[1], b[1]);
}

// ---------------------------------------------------------------------------
// the watch itself
// ---------------------------------------------------------------------------

/** An IPO still waiting for its result, as the watch needs to see it. */
export type WatchedIpo = {
  id: string;
  companyName: string;
  /** This registrar's id for the issue, when an earlier sync already found it. */
  companyId: string | null;
};

export type WatchHit = { ipoId: string; companyId: string };

/**
 * Which of `watched` this registrar is now answering allotment queries for.
 *
 * Two ways to hit, in priority order. A stored company id is an exact key the
 * registrar itself issued, so when we have one it is the whole test — no name
 * comparison can improve on it, and none should be allowed to contradict it.
 * Only an IPO with no id yet falls through to name matching, which is the case
 * that matters most: an issue Bigshare had not listed the last time sync-ipos
 * ran has no id, and is exactly the issue whose result just landed.
 *
 * Unlike sync-ipos' resolveCompanyMatch this builds no indexes and threads no
 * `claimed` set. The watch set is the handful of IPOs allotting tonight, so a
 * direct scan is both clearer and faster than the machinery a full dropdown
 * pass needs. First match wins for the same reason it does there — registrar
 * listings are short and ordered, and a second look-alike is far likelier to be
 * a near-duplicate than a second real issue.
 */
export function matchWatchedIpos(
  companies: RegistrarCompany[],
  watched: WatchedIpo[],
): WatchHit[] {
  if (companies.length === 0 || watched.length === 0) return [];

  const liveIds = new Set(companies.map((c) => c.id));
  const hits: WatchHit[] = [];

  for (const ipo of watched) {
    if (ipo.companyId) {
      if (liveIds.has(ipo.companyId)) hits.push({ ipoId: ipo.id, companyId: ipo.companyId });
      continue;
    }

    const words = significantWords(ipo.companyName);
    if (words.length === 0) continue;

    const match = companies.find((c) => firstTwoWordsMatch(words, significantWords(c.name)));
    if (match) hits.push({ ipoId: ipo.id, companyId: match.id });
  }

  return hits;
}
