/**
 * The sync scrapes four undocumented feeds whose columns are HTML fragments
 * written for a browser table. Almost every defect in that pipeline is a
 * parsing defect, and none of it can be exercised end-to-end without hitting
 * live third-party endpoints — so the pure layer carries the whole test burden.
 *
 * `resolveIpoId` is the one that matters most. Attaching a grey market chart to
 * the wrong company is worse than showing no chart at all, and nothing in
 * production would alert anyone that it happened.
 *
 * The fixtures below are copied verbatim from live responses on 2026-08-10, so
 * the escaping and entity quirks are real rather than imagined.
 */
import {
  buildIpoIndexes,
  chittorgarhRow,
  decodeEntities,
  financialYear,
  financialYearsToFetch,
  type GmpReading,
  gmpRow,
  normalizeName,
  observedAtFrom,
  parseDate,
  parseGmp,
  parsePriceBand,
  resolveIpoId,
  slugFromPath,
  statusFor,
  stripTags,
  symbolFromSlug,
  toNumber,
} from './parse.ts';

// --- fixtures --------------------------------------------------------------

const CG_ROW: Record<string, unknown> = {
  Company:
    '<a href="https://www.chittorgarh.com/ipo/shiprocket-ipo/2450/" title="Shiprocket IPO Details">Shiprocket Ltd.</a> ',
  'Issue Category': 'Mainboard',
  'Opening Date': '12-Aug-2026',
  'Closing Date': '14-Aug-2026',
  'Issue Price (Rs.)': '92.00 to 97.00',
  'Issue Amount (Rs.cr.)': '1617.48',
  'Listing at': 'BSE, NSE',
  '~URLRewrite_Folder_Name': 'shiprocket-ipo',
  '~IssueCloseDate': '2026-08-14T00:00:00.000Z',
  '~ListingDate': '2026-08-19T00:00:00.000Z',
  '~isin': '',
  '~bse_script_code': '',
  '~nse_symbol': '',
  '~issue_open_date_plan': '2026-08-12',
};

const GMP_ROW: Record<string, unknown> = {
  Name: '<a href="/gmp/qt-foods-ipo/2299/" title="Q&T Foods" target="_parent">Q&T Foods</a> <span class="badge">BSE SME</span>',
  GMP: '&#8377;<b>6</b> (5.22%)<br><small style="font-size: 12px;"><b>6 &darr; / 6 &uarr;</b></small>',
  Sub: '-',
  'Price (₹)': '115',
  Lot: '1200',
  '~id': 2299,
  'Updated-On': '<small style="font-size: 12px; color: #007BFF;"><b>9-Aug 23:34</b></small>',
  '~Srt_Open': '2026-08-12',
  '~urlrewrite_folder_name': '/gmp/qt-foods-ipo/2299/',
  '~IPO_Category': 'SME',
  '~gmp_percent_calc': '5.22',
  '~ipo_name': 'Q&T Foods',
};

const RUN = '2026-08-10T04:00:00.000Z';

function reading(patch: Partial<GmpReading> = {}): GmpReading {
  return {
    provider: 'CHITTORGARH',
    provider_slug: 'qt-foods-ipo',
    company_name: 'Q&T Foods',
    open_date: '2026-08-12',
    observed_at: RUN,
    gmp: 6,
    gmp_percent: 5.22,
    price: 115,
    sub_times: null,
    source_url: null,
    ...patch,
  };
}

// --- the crux --------------------------------------------------------------

describe('resolveIpoId', () => {
  const indexes = buildIpoIndexes([
    { id: 'ipo-qt', symbol: 'QTFOODS', company_name: 'Q&T Foods Ltd.', open_date: '2026-08-12' },
    { id: 'ipo-ship', symbol: 'SHIPROCKET', company_name: 'Shiprocket Ltd.', open_date: '2026-08-12' },
  ]);
  const slugIndex = new Map([
    ['qt-foods-ipo', { symbol: 'QTFOODS', open_date: '2026-08-12' }],
  ]);

  it('matches through the slug when the list leg ran in the same sync', () => {
    expect(resolveIpoId(reading(), slugIndex, indexes)).toBe('ipo-qt');
  });

  it('falls back to name plus open date when the slug is unknown', () => {
    expect(resolveIpoId(reading(), new Map(), indexes)).toBe('ipo-qt');
  });

  it('matches a company whose name is spelled differently by each feed', () => {
    const row = reading({ company_name: 'Q and T Foods Private Limited' });
    expect(resolveIpoId(row, new Map(), indexes)).toBe('ipo-qt');
  });

  it('accepts an open date that moved by a couple of days', () => {
    const row = reading({ open_date: '2026-08-14' });
    expect(resolveIpoId(row, new Map(), indexes)).toBe('ipo-qt');
  });

  it('refuses to guess when two candidates are both within the date window', () => {
    const ambiguous = buildIpoIndexes([
      { id: 'a', symbol: 'QTF1', company_name: 'Q&T Foods', open_date: '2026-08-11' },
      { id: 'b', symbol: 'QTF2', company_name: 'Q&T Foods', open_date: '2026-08-13' },
    ]);
    expect(resolveIpoId(reading({ open_date: '2026-08-12' }), new Map(), ambiguous)).toBeNull();
  });

  it('returns null rather than attaching a reading to an unrelated company', () => {
    const row = reading({ provider_slug: 'nobody-ipo', company_name: 'Some Other Co' });
    expect(resolveIpoId(row, new Map(), indexes)).toBeNull();
  });

  it('returns null when the open date is too far from any candidate', () => {
    expect(resolveIpoId(reading({ open_date: '2026-09-30' }), new Map(), indexes)).toBeNull();
  });
});

// --- timestamps ------------------------------------------------------------

describe('observedAtFrom', () => {
  it('reads the IST stamp and converts it to UTC', () => {
    // 9 Aug 23:34 IST is 9 Aug 18:04 UTC.
    expect(observedAtFrom(GMP_ROW['Updated-On'], RUN)).toBe('2026-08-09T18:04:00.000Z');
  });

  it('infers the year from the run date', () => {
    expect(observedAtFrom('<b>3-Feb 10:00</b>', '2027-02-04T04:00:00.000Z')).toBe(
      '2027-02-03T04:30:00.000Z',
    );
  });

  it('files a December reading under the previous year when run in January', () => {
    expect(observedAtFrom('<b>31-Dec 23:00</b>', '2027-01-01T04:00:00.000Z')).toBe(
      '2026-12-31T17:30:00.000Z',
    );
  });

  it('falls back to the run timestamp rather than null, which would break dedupe', () => {
    expect(observedAtFrom('not a date', RUN)).toBe(RUN);
    expect(observedAtFrom(null, RUN)).toBe(RUN);
  });
});

// --- GMP cell --------------------------------------------------------------

describe('parseGmp', () => {
  it('pulls the premium and percentage out of the HTML cell', () => {
    expect(parseGmp(GMP_ROW.GMP)).toEqual({ gmp: 6, percent: 5.22 });
  });

  it('treats "--" as no quote, not as zero premium', () => {
    expect(parseGmp('&#8377;<b>--</b> (0.00%)<br><small><b>0 / 0</b></small>')).toEqual({
      gmp: null,
      percent: null,
    });
  });

  it('handles a discount', () => {
    expect(parseGmp('&#8377;<b>-12</b> (-8.50%)')).toEqual({ gmp: -12, percent: -8.5 });
  });

  it('ignores the second line, which is a high/low range not a premium', () => {
    expect(parseGmp('&#8377;<b>22</b> (22.68%)<br><small><b>14 / 99</b></small>').gmp).toBe(22);
  });
});

// --- identity --------------------------------------------------------------

describe('normalizeName', () => {
  it('collapses every spelling of one company to the same key', () => {
    const expected = normalizeName('Q&T Foods');
    expect(normalizeName('Q&amp;T Foods')).toBe(expected);
    expect(normalizeName('Q & T Foods Ltd. IPO')).toBe(expected);
    expect(normalizeName('Q and T Foods Private Limited')).toBe(expected);
    expect(normalizeName('  q&t   foods  ')).toBe(expected);
  });

  it('keeps genuinely different companies apart', () => {
    expect(normalizeName('Shiprocket Ltd.')).not.toBe(normalizeName('Q&T Foods'));
  });

  it('is empty for junk, so callers can refuse to match on it', () => {
    expect(normalizeName('Ltd.')).toBe('');
    expect(normalizeName(null)).toBe('');
  });
});

describe('slugFromPath', () => {
  it('extracts the slug from a GMP path', () => {
    expect(slugFromPath('/gmp/qt-foods-ipo/2299/')).toBe('qt-foods-ipo');
  });

  it('passes a bare slug through, which is how the IPO list supplies it', () => {
    expect(slugFromPath('shiprocket-ipo')).toBe('shiprocket-ipo');
  });

  it('is null for junk', () => {
    expect(slugFromPath('')).toBeNull();
    expect(slugFromPath('/gmp/')).toBeNull();
    expect(slugFromPath(42)).toBeNull();
  });
});

describe('symbolFromSlug', () => {
  it('builds a usable symbol and drops the -ipo suffix', () => {
    expect(symbolFromSlug('qt-foods-ipo')).toBe('QTFOODS');
    expect(symbolFromSlug('behari-lal-engineering-ipo')).toBe('BEHARILALENGINEERING');
  });

  it('stays within a sane length', () => {
    expect(symbolFromSlug('a-very-long-company-name-that-goes-on-ipo').length).toBeLessThanOrEqual(20);
  });
});

// --- HTML ------------------------------------------------------------------

describe('decodeEntities and stripTags', () => {
  it('decodes numeric and named entities', () => {
    expect(decodeEntities('&#8377;100')).toBe('₹100');
    expect(decodeEntities('Q&amp;T')).toBe('Q&T');
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
  });

  it('does not turn an escaped entity into a real tag', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('strips nested markup down to text', () => {
    expect(stripTags('<small><b>9-Aug 23:34</b></small>')).toBe('9-Aug 23:34');
  });
});

// --- row mapping -----------------------------------------------------------

describe('chittorgarhRow', () => {
  it('maps a live row, including the listing date no exchange supplies', () => {
    const record = chittorgarhRow(CG_ROW, new Map(), '2026-08-10');
    expect(record).toMatchObject({
      symbol: 'SHIPROCKET',
      company_name: 'Shiprocket Ltd.',
      exchange: 'NSE',
      segment: 'MAINBOARD',
      status: 'UPCOMING',
      open_date: '2026-08-12',
      close_date: '2026-08-14',
      listing_date: '2026-08-19',
      price_band_min: 92,
      price_band_max: 97,
      issue_size_cr: 1617.48,
      source: 'CHITTORGARH',
    });
  });

  it('reuses the symbol an exchange already used this run, instead of duplicating', () => {
    const prior = new Map([[`${normalizeName('Shiprocket Ltd.')}|2026-08-12`, 'SHPRKT']]);
    expect(chittorgarhRow(CG_ROW, prior, '2026-08-10')?.symbol).toBe('SHPRKT');
  });

  it('prefers a real exchange symbol over both', () => {
    const withSymbol = { ...CG_ROW, '~nse_symbol': 'SHIPROCK' };
    const prior = new Map([[`${normalizeName('Shiprocket Ltd.')}|2026-08-12`, 'SHPRKT']]);
    expect(chittorgarhRow(withSymbol, prior, '2026-08-10')?.symbol).toBe('SHIPROCK');
  });

  it('marks SME issues', () => {
    expect(chittorgarhRow({ ...CG_ROW, 'Issue Category': 'SME' }, new Map())?.segment).toBe('SME');
  });

  it('skips rows with no open date, which would duplicate on every run', () => {
    const undated = { ...CG_ROW, '~issue_open_date_plan': '', 'Opening Date': '' };
    expect(chittorgarhRow(undated)).toBeNull();
  });

  it('skips rows with no company name', () => {
    expect(chittorgarhRow({ ...CG_ROW, Company: '' })).toBeNull();
  });
});

describe('gmpRow', () => {
  it('maps a live GMP row', () => {
    expect(gmpRow(GMP_ROW, RUN)).toEqual({
      provider: 'CHITTORGARH',
      provider_slug: 'qt-foods-ipo',
      company_name: 'Q&T Foods',
      open_date: '2026-08-12',
      observed_at: '2026-08-09T18:04:00.000Z',
      gmp: 6,
      gmp_percent: 5.22,
      price: 115,
      sub_times: null,
      source_url: 'https://www.investorgain.com/gmp/qt-foods-ipo/2299/',
    });
  });

  it('reads "-" subscription as unknown rather than zero', () => {
    expect(gmpRow(GMP_ROW, RUN)?.sub_times).toBeNull();
  });

  it('drops the percentage when there is no quote', () => {
    const noQuote = { ...GMP_ROW, GMP: '&#8377;<b>--</b> (0.00%)', '~gmp_percent_calc': '0.00' };
    expect(gmpRow(noQuote, RUN)).toMatchObject({ gmp: null, gmp_percent: null });
  });

  it('skips a row with no slug, since the slug is the only reliable join key', () => {
    expect(gmpRow({ ...GMP_ROW, '~urlrewrite_folder_name': '' }, RUN)).toBeNull();
  });
});

// --- financial year --------------------------------------------------------

describe('financialYear', () => {
  it('runs April to March', () => {
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(financialYear('2026-08-10')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2026-03-31')).toBe('2025-26');
    expect(financialYear('2026-01-15')).toBe('2025-26');
  });

  it('pads the second half of the century boundary', () => {
    expect(financialYear('2099-05-01')).toBe('2099-00');
  });
});

describe('financialYearsToFetch', () => {
  it('fetches only the current year for most of the year', () => {
    expect(financialYearsToFetch('2026-08-10')).toEqual(['2026-27']);
  });

  it('also fetches the previous year through the first quarter', () => {
    // Otherwise every 1 April, issues that opened in March silently vanish.
    expect(financialYearsToFetch('2026-04-01')).toEqual(['2026-27', '2025-26']);
    expect(financialYearsToFetch('2026-06-30')).toEqual(['2026-27', '2025-26']);
    expect(financialYearsToFetch('2026-07-01')).toEqual(['2026-27']);
  });
});

// --- primitives retrofitted from index.ts ----------------------------------

describe('parseDate', () => {
  it('reads the exchange format', () => {
    expect(parseDate('12-Aug-2026')).toBe('2026-08-12');
    expect(parseDate('9-Aug-2026')).toBe('2026-08-09');
  });

  it('passes ISO through', () => {
    expect(parseDate('2026-08-12T00:00:00.000Z')).toBe('2026-08-12');
  });

  it('is null for junk', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('parsePriceBand', () => {
  it('reads a band', () => {
    expect(parsePriceBand('92.00 to 97.00')).toEqual([92, 97]);
    expect(parsePriceBand('₹ 100 - 105')).toEqual([100, 105]);
  });

  it('repeats a single price as both ends', () => {
    expect(parsePriceBand('105')).toEqual([105, 105]);
  });

  it('is null for junk', () => {
    expect(parsePriceBand('')).toEqual([null, null]);
    expect(parsePriceBand(undefined)).toEqual([null, null]);
  });
});

describe('toNumber', () => {
  it('strips currency and separators', () => {
    expect(toNumber('₹1,617.48 Cr')).toBe(1617.48);
    expect(toNumber(42)).toBe(42);
  });

  it('is null for the feed placeholders', () => {
    expect(toNumber('-')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
  });
});

describe('statusFor', () => {
  it('walks the lifecycle across the boundary days', () => {
    expect(statusFor('2026-08-12', '2026-08-14', '2026-08-11')).toBe('UPCOMING');
    expect(statusFor('2026-08-12', '2026-08-14', '2026-08-12')).toBe('OPEN');
    expect(statusFor('2026-08-12', '2026-08-14', '2026-08-14')).toBe('OPEN');
    expect(statusFor('2026-08-12', '2026-08-14', '2026-08-15')).toBe('CLOSED');
  });

  it('assumes upcoming when the window is incomplete', () => {
    expect(statusFor('2026-08-12', null, '2026-08-13')).toBe('UPCOMING');
    expect(statusFor(null, null, '2026-08-13')).toBe('UPCOMING');
  });
});
