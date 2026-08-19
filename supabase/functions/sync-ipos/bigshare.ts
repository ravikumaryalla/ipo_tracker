/**
 * Bigshare's "Select Company" dropdown → the currently-open issues its
 * allotment-status lookup will answer for.
 *
 * Deliberately free of imports, `Deno.*`, and network calls, same reason as
 * parse.ts: it's the only part of this leg that can run under Node, so it's
 * the only part that gets tested.
 *
 * Unlike KFintech, which bakes its whole company directory into a JS bundle,
 * Bigshare's ipo_status.html carries the dropdown directly as plain
 * `<option value="id">NAME</option>` tags — but only for issues currently
 * open to a query. Every older issue is still present in the markup, just
 * wrapped in an HTML comment, so this only has to find the *uncommented*
 * options rather than maintain any notion of "current".
 */

const OPTION_RE = /<option\s+value="(\d+)">([^<]+)<\/option>/g;

/**
 * Strips every `<!--...-->` block first, so a regex walk over what's left
 * only ever sees live options — no need to reason about comment nesting or
 * partial matches inside a commented-out block.
 */
export function parseBigshareCompanies(html: string): { id: string; name: string }[] {
  const ddlMatch = html.match(/<select[^>]*\bid="ddlCompany"[^>]*>([\s\S]*?)<\/select>/i);
  if (!ddlMatch) return [];

  const withoutComments = ddlMatch[1].replace(/<!--[\s\S]*?-->/g, '');

  const companies: { id: string; name: string }[] = [];
  let match: RegExpExecArray | null;
  OPTION_RE.lastIndex = 0;
  while ((match = OPTION_RE.exec(withoutComments))) {
    const name = match[2].trim();
    if (name && name !== '--Select Company--') companies.push({ id: match[1], name });
  }
  return companies;
}
