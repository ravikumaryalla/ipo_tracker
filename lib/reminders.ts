/**
 * Which reminders an IPO deserves, and when.
 *
 * Kept free of expo-notifications and react-native imports on purpose: this is
 * date arithmetic around "has the user applied yet", which is worth testing on
 * its own. lib/notifications.ts turns these into scheduled notifications.
 */
import type { Ipo } from './types';

export type Reminder = { id: string; title: string; body: string; when: Date };

/** `hour` o'clock local on the given date. Null when that moment has already passed. */
function onDateAt(isoDate: string, hour = 9): Date | null {
  const when = new Date(`${isoDate}T00:00:00`);
  when.setHours(hour, 0, 0, 0);
  return when.getTime() > Date.now() ? when : null;
}

export function remindersFor(ipo: Ipo, hasApplication: boolean): Reminder[] {
  const out: Reminder[] = [];

  // Closing reminder only matters if you have NOT applied yet.
  if (!hasApplication && ipo.close_date) {
    const when = onDateAt(ipo.close_date);
    if (when) {
      out.push({
        id: `${ipo.id}:close`,
        title: `${ipo.symbol} closes today`,
        body: `Last day to apply to ${ipo.company_name}.`,
        when,
      });
    }
  }

  // There is deliberately no allotment reminder here. There used to be one at
  // 21:00 on allotment_date, but it was pure date arithmetic — it fired whether
  // or not a result existed, and allotment_date is a scraped estimate that
  // slips. The server now watches for the result actually being published and
  // pushes "Allotment results are out" when it is (see
  // supabase/functions/check-allotments/registrarWatch.ts), so a local guess
  // firing first could only ever send someone into an empty check.
  //
  // Listing only matters once you have applied.
  if (hasApplication && ipo.listing_date) {
    const when = onDateAt(ipo.listing_date);
    if (when) {
      out.push({
        id: `${ipo.id}:listing`,
        title: `${ipo.symbol} lists today`,
        body: `${ipo.company_name} is listing — check the price.`,
        when,
      });
    }
  }

  return out;
}
