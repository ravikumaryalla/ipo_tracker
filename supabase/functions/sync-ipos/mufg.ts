/**
 * MUFG Intime's company list → the currently-open issues its allotment-
 * status lookup will answer for.
 *
 * Deliberately free of imports, `Deno.*`, and network calls, same reason as
 * parse.ts and bigshare.ts: it's the only part of this leg that can run
 * under Node, so it's the only part that gets tested.
 *
 * `IPO.aspx/GetDetails` returns `{"d": "<xml string>"}` — an ADO.NET
 * NewDataSet serialised as a string, not real JSON. There's no DOM/XML
 * library worth pulling into an Edge Function for three or four rows, so
 * this walks it with the same regex-over-markup approach the rest of this
 * sync uses for HTML. Confirmed live on 2026-08-19:
 *
 *   <NewDataSet>
 *     <Table><company_id>11922</company_id><companyname>Behari Lal Engineering Limited - IPO</companyname></Table>
 *     ...
 *   </NewDataSet>
 */

const TABLE_RE = /<Table>([\s\S]*?)<\/Table>/g;

function tagText(row: string, tag: string): string | null {
  const m = row.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

export function parseMufgCompanies(xml: string): { id: string; name: string }[] {
  const companies: { id: string; name: string }[] = [];
  let match: RegExpExecArray | null;
  TABLE_RE.lastIndex = 0;
  while ((match = TABLE_RE.exec(xml))) {
    const id = tagText(match[1], 'company_id');
    // MUFG's own listing suffixes every name with " - IPO"; stripped here so
    // it matches the plain company_name normalizeName sees from every other
    // provider, rather than only ever matching through the noise filter.
    const name = tagText(match[1], 'companyname')?.replace(/\s*-\s*IPO$/i, '').trim();
    if (id && name) companies.push({ id, name });
  }
  return companies;
}
