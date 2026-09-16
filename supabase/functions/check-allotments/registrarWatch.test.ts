/**
 * Fixtures mirror the real markup the two registrars serve — the same shapes
 * supabase/functions/sync-ipos/bigshare.test.ts and mufg.test.ts capture, since
 * registrarWatch.ts ports those parsers verbatim.
 *
 * The parser tests here are deliberately not a copy of sync-ipos': they exist to
 * catch the ports drifting from their originals, so they pin the one property
 * this module depends on that sync-ipos only happens to have — that a listed
 * issue means "answerable now", and a commented-out one means "not yet".
 */
import {
  firstTwoWordsMatch,
  matchWatchedIpos,
  mufgXmlFromBody,
  parseBigshareCompanies,
  parseMufgCompanies,
  sharesLongPrefix,
  significantWords,
} from './registrarWatch.ts';

const bigshareHtml = (inner: string) =>
  `<html><body><form><select name="ddlCompany" id="ddlCompany" class="form-control">
     <option value="0">--Select Company--</option>
     ${inner}
   </select></form></body></html>`;

describe('parseBigshareCompanies', () => {
  it('reads the live options and drops the placeholder', () => {
    const html = bigshareHtml(
      `<option value="1109">SHREE REFRIGERATIONS LIMITED</option>
       <option value="1110">MONARCH SURVEYORS LIMITED</option>`,
    );
    expect(parseBigshareCompanies(html)).toEqual([
      { id: '1109', name: 'SHREE REFRIGERATIONS LIMITED' },
      { id: '1110', name: 'MONARCH SURVEYORS LIMITED' },
    ]);
  });

  // The whole detection rests on this: Bigshare keeps closed issues in the
  // markup but comments them out, so a commented issue is one whose allotment
  // is not answerable — which for us means "results are not out".
  it('ignores issues Bigshare has commented out', () => {
    const html = bigshareHtml(
      `<option value="1109">SHREE REFRIGERATIONS LIMITED</option>
       <!-- <option value="1042">OLD CLOSED ISSUE LIMITED</option> -->`,
    );
    expect(parseBigshareCompanies(html)).toEqual([
      { id: '1109', name: 'SHREE REFRIGERATIONS LIMITED' },
    ]);
  });

  it('returns nothing when the dropdown is absent or empty', () => {
    expect(parseBigshareCompanies('<html><body>maintenance</body></html>')).toEqual([]);
    expect(parseBigshareCompanies(bigshareHtml(''))).toEqual([]);
  });
});

describe('parseMufgCompanies', () => {
  const xml =
    '<NewDataSet>' +
    '<Table><company_id>11922</company_id><companyname>Behari Lal Engineering Limited - IPO</companyname></Table>' +
    '<Table><company_id>11930</company_id><companyname>Vikran Engineering Limited - IPO</companyname></Table>' +
    '</NewDataSet>';

  it('reads company_id/companyname and strips the " - IPO" suffix', () => {
    expect(parseMufgCompanies(xml)).toEqual([
      { id: '11922', name: 'Behari Lal Engineering Limited' },
      { id: '11930', name: 'Vikran Engineering Limited' },
    ]);
  });

  it('skips rows missing either field', () => {
    const partial =
      '<NewDataSet>' +
      '<Table><company_id>11922</company_id></Table>' +
      '<Table><companyname>No Id Limited - IPO</companyname></Table>' +
      '</NewDataSet>';
    expect(parseMufgCompanies(partial)).toEqual([]);
  });

  it('returns nothing for an empty dataset', () => {
    expect(parseMufgCompanies('<NewDataSet></NewDataSet>')).toEqual([]);
  });
});

describe('mufgXmlFromBody', () => {
  it('unwraps the ASP.NET "d" envelope', () => {
    expect(mufgXmlFromBody({ d: '<NewDataSet></NewDataSet>' })).toBe('<NewDataSet></NewDataSet>');
  });

  it('returns an empty string for anything else', () => {
    expect(mufgXmlFromBody(null)).toBe('');
    expect(mufgXmlFromBody({})).toBe('');
    expect(mufgXmlFromBody({ d: 42 })).toBe('');
  });
});

describe('significantWords', () => {
  it('strips noise words, the IPO suffix and punctuation', () => {
    expect(significantWords('Vikran Engineering Limited - IPO')).toEqual(['vikran', 'engineering']);
    expect(significantWords('Q & T Foods Private Limited')).toEqual(['q', 'and', 't', 'foods']);
    expect(significantWords('Q &amp; T Foods Ltd.')).toEqual(['q', 'and', 't', 'foods']);
  });

  it('returns an empty list for a name that is all noise', () => {
    expect(significantWords('The India Company Limited')).toEqual([]);
    expect(significantWords(null)).toEqual([]);
  });
});

describe('sharesLongPrefix', () => {
  it('bridges a registrar spelling variant', () => {
    expect(sharesLongPrefix('jewellery', 'jewellers')).toBe(true);
  });

  it('does not fire on genuinely different short words', () => {
    expect(sharesLongPrefix('steel', 'steamers')).toBe(false);
  });
});

describe('firstTwoWordsMatch', () => {
  it('requires the first word to match exactly', () => {
    expect(firstTwoWordsMatch(['vikran', 'engineering'], ['vikram', 'engineering'])).toBe(false);
  });

  it('accepts a one-word side once the first word matches', () => {
    expect(firstTwoWordsMatch(['monarch'], ['monarch', 'surveyors'])).toBe(true);
  });
});

describe('matchWatchedIpos', () => {
  const companies = [
    { id: '1109', name: 'SHREE REFRIGERATIONS LIMITED' },
    { id: '1110', name: 'MONARCH SURVEYORS LIMITED' },
  ];

  it('hits on a stored company id', () => {
    expect(
      matchWatchedIpos(companies, [
        { id: 'ipo-a', companyName: 'Anything At All', companyId: '1110' },
      ]),
    ).toEqual([{ ipoId: 'ipo-a', companyId: '1110' }]);
  });

  // The id is the registrar's own key, so it settles the question on its own —
  // a name that would have matched a different row must not override it.
  it('does not fall back to the name when a stored id is absent from the list', () => {
    expect(
      matchWatchedIpos(companies, [
        { id: 'ipo-a', companyName: 'Monarch Surveyors Limited', companyId: '9999' },
      ]),
    ).toEqual([]);
  });

  it('matches by name and reports the id to backfill when none is stored', () => {
    expect(
      matchWatchedIpos(companies, [
        { id: 'ipo-a', companyName: 'Monarch Surveyors Ltd', companyId: null },
      ]),
    ).toEqual([{ ipoId: 'ipo-a', companyId: '1110' }]);
  });

  it('leaves an IPO the registrar is not yet answering for unmatched', () => {
    expect(
      matchWatchedIpos(companies, [
        { id: 'ipo-a', companyName: 'Vikran Engineering Limited', companyId: null },
      ]),
    ).toEqual([]);
  });

  it('does not match a look-alike first word', () => {
    expect(
      matchWatchedIpos(companies, [
        { id: 'ipo-a', companyName: 'Monarch Steel Limited', companyId: null },
      ]),
    ).toEqual([]);
  });

  it('skips a name that reduces to nothing rather than matching arbitrarily', () => {
    expect(
      matchWatchedIpos(companies, [
        { id: 'ipo-a', companyName: 'The Company Limited', companyId: null },
      ]),
    ).toEqual([]);
  });

  it('returns nothing when either side is empty', () => {
    expect(matchWatchedIpos([], [{ id: 'a', companyName: 'X Ltd', companyId: null }])).toEqual([]);
    expect(matchWatchedIpos(companies, [])).toEqual([]);
  });
});
