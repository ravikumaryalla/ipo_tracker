/**
 * Turns the reminders computed in lib/reminders.ts into scheduled local
 * notifications.
 *
 * Local, not push: every date we care about is already known on the device, so
 * a server round-trip would add nothing — and it keeps the app free of push
 * tokens and a notification backend.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { remindersFor } from './reminders';
import type { Ipo } from './types';

export { remindersFor } from './reminders';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermission(): Promise<boolean> {
  // Web has no local notification scheduling. Reporting "no permission" here is
  // enough: syncReminders() already bails out on false, so the settings screen
  // says "nothing to schedule" instead of crashing in scheduleNotificationAsync.
  if (Platform.OS === 'web') return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('ipo-reminders', {
      name: 'IPO reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/**
 * Rebuild the whole reminder schedule.
 *
 * Cancelling everything first is deliberate: IPO dates get revised, and
 * reconciling individual notifications against a moving schedule is far more
 * error-prone than rescheduling from scratch.
 */
export async function syncReminders(ipos: Ipo[], appliedIpoIds: Set<string>): Promise<number> {
  if (!(await requestNotificationPermission())) return 0;

  await Notifications.cancelAllScheduledNotificationsAsync();

  let scheduled = 0;
  for (const ipo of ipos) {
    for (const reminder of remindersFor(ipo, appliedIpoIds.has(ipo.id))) {
      await Notifications.scheduleNotificationAsync({
        identifier: reminder.id,
        content: { title: reminder.title, body: reminder.body },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: reminder.when,
          channelId: 'ipo-reminders',
        },
      });
      scheduled += 1;
    }
  }
  return scheduled;
}

export async function cancelAllReminders(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}
