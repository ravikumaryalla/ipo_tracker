/**
 * Fixture trimmed verbatim from https://ipo.bigshareonline.com/ipo_status.html
 * on 2026-08-19 — real markup, real quirks (mismatched/nested comment
 * delimiters in the historical block, a couple of malformed `<option>` tags
 * missing their opening `<`), all of which must stay inert since they're
 * commented out.
 */
import { parseBigshareCompanies } from './bigshare.ts';

const DDL_HTML = `
<select id="ddlCompany">
<option>--Select Company--</option>
<option value="9043">TECHNOCRAFT VENTURES LIMITED</option>
<!-- <option value="587">ANAWIL WIRE AND ENGINEERING LIMITED</option>
<option value="586">METALIC TECHNOFORGE LIMITED</option>
<option value="583">VINIT MOBILE LIMITED</option> -->
<!-- <option value="9041">AASTHA SPINTEX LIMITED</option> -->
<!--<option value="582">JIVIAL INDUSTRIES LIMITED</option>
<option value="581">ANUBHAV PLAST LIMITED</option>
<<option value="9031">JARO INSTITUTE OF TECHNOLOGY MANAGEMENT AND RESEARCH LIMITED</option>
option value="531">TAURIAN MPS LIMITED</option>
<option value="519">VANDAN FOODS LIMITED</option>-->
</select>
`;

describe('parseBigshareCompanies', () => {
  it('returns only the live (uncommented) option', () => {
    expect(parseBigshareCompanies(DDL_HTML)).toEqual([
      { id: '9043', name: 'TECHNOCRAFT VENTURES LIMITED' },
    ]);
  });

  it('drops the placeholder option', () => {
    const html = `<select id="ddlCompany"><option>--Select Company--</option></select>`;
    expect(parseBigshareCompanies(html)).toEqual([]);
  });

  it('returns empty when the dropdown is missing entirely', () => {
    expect(parseBigshareCompanies('<html><body>no dropdown here</body></html>')).toEqual([]);
  });

  it('handles more than one live option', () => {
    const html = `<select id="ddlCompany">
      <option value="1">FIRST LIMITED</option>
      <option value="2">SECOND LIMITED</option>
      <!-- <option value="3">THIRD LIMITED</option> -->
    </select>`;
    expect(parseBigshareCompanies(html)).toEqual([
      { id: '1', name: 'FIRST LIMITED' },
      { id: '2', name: 'SECOND LIMITED' },
    ]);
  });
});
