/**
 * Fixture trimmed verbatim from the live IPO.aspx/GetDetails response on
 * 2026-08-19 — see mufg.ts's header comment.
 */
import { parseMufgCompanies } from './mufg.ts';

const LIVE_XML = `<NewDataSet>
  <Table>
    <company_id>11922</company_id>
    <companyname>Behari Lal Engineering Limited - IPO</companyname>
  </Table>
  <Table>
    <company_id>11921</company_id>
    <companyname>Leap India Limited - IPO</companyname>
  </Table>
  <Table>
    <company_id>11915</company_id>
    <companyname>Indo-Mim Limited - IPO</companyname>
  </Table>
</NewDataSet>`;

describe('parseMufgCompanies', () => {
  it('parses the live response shape and strips the trailing " - IPO"', () => {
    expect(parseMufgCompanies(LIVE_XML)).toEqual([
      { id: '11922', name: 'Behari Lal Engineering Limited' },
      { id: '11921', name: 'Leap India Limited' },
      { id: '11915', name: 'Indo-Mim Limited' },
    ]);
  });

  it('returns empty when there are no <Table> rows', () => {
    expect(parseMufgCompanies('<NewDataSet></NewDataSet>')).toEqual([]);
  });

  it('returns empty on unparseable input', () => {
    expect(parseMufgCompanies('')).toEqual([]);
    expect(parseMufgCompanies('not xml at all')).toEqual([]);
  });

  it('skips a row missing either field', () => {
    const xml = `<NewDataSet><Table><company_id>1</company_id></Table></NewDataSet>`;
    expect(parseMufgCompanies(xml)).toEqual([]);
  });
});
