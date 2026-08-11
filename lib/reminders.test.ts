/**
 * remindersFor decides what the user gets pinged about. The rules that matter:
 * don't nag about applying to something already applied for, don't remind about
 * allotment for something never applied to, and never schedule into the past.
 */
import { remindersFor } from './reminders';
import type { Ipo } from './types';

function ipo(patch: Partial<Ipo>): Ipo {
  return {
    id: 'i1',
    symbol: 'TESTCO',
    company_name: 'Test Co',
    exchange: 'NSE',
    segment: 'MAINBOARD',
    status: 'OPEN',
    open_date: null,
    close_date: null,
    allotment_date: null,
    listing_date: null,
    price_band_min: null,
    price_band_max: null,
    lot_size: null,
    issue_size_cr: null,
    listing_price: null,
    current_price: null,
    registrar: null,
    registrar_url: null,
    kfintech_company_id: null,
    source: 'MANUAL',
    created_by: null,
    last_synced_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...patch,
  };
}

/** A date comfortably in the future, so 9am on it has not passed. */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('remindersFor', () => {
  it('reminds about the closing date when you have not applied', () => {
    const reminders = remindersFor(ipo({ close_date: daysFromNow(3) }), false);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].id).toBe('i1:close');
    expect(reminders[0].title).toContain('closes today');
  });

  it('does not nag about closing once you have applied', () => {
    const reminders = remindersFor(ipo({ close_date: daysFromNow(3) }), true);
    expect(reminders.find((r) => r.id.endsWith(':close'))).toBeUndefined();
  });

  it('reminds about allotment and listing only once you have applied', () => {
    const withDates = ipo({
      allotment_date: daysFromNow(5),
      listing_date: daysFromNow(8),
    });

    expect(remindersFor(withDates, false)).toHaveLength(0);

    const applied = remindersFor(withDates, true);
    expect(applied.map((r) => r.id).sort()).toEqual(['i1:allotment', 'i1:listing']);
  });

  it('never schedules a reminder in the past', () => {
    const past = ipo({
      close_date: daysFromNow(-5),
      allotment_date: daysFromNow(-3),
      listing_date: daysFromNow(-1),
    });
    expect(remindersFor(past, false)).toHaveLength(0);
    expect(remindersFor(past, true)).toHaveLength(0);
  });

  it('schedules every reminder for the morning', () => {
    const reminders = remindersFor(
      ipo({ allotment_date: daysFromNow(4), listing_date: daysFromNow(6) }),
      true,
    );
    for (const reminder of reminders) {
      expect(reminder.when.getHours()).toBe(9);
      expect(reminder.when.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('produces nothing for an IPO with no dates', () => {
    expect(remindersFor(ipo({}), true)).toHaveLength(0);
  });
});
