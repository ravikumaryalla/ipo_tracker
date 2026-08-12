/**
 * Two notification systems share this file:
 *
 *  - Local, date-scheduled reminders (closing/allotment/listing dates) —
 *    every date is already known on the device, so these are scheduled
 *    entirely client-side.
 *  - Push, for allotment results: those resolve at a moment the *server*
 *    discovers by polling KFintech (supabase/functions/check-allotments),
 *    which no on-device schedule can predict — this needs a real push
 *    token registered against this device, sent from there instead.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { deletePushToken, hasPushToken, upsertPushToken } from './db/pushTokens';
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
    await Notifications.setNotificationChannelAsync('allotment-results', {
      name: 'Allotment results',
      importance: Notifications.AndroidImportance.HIGH,
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

/**
 * This device's push token, or null when push isn't available here (web, a
 * simulator, or no EAS project configured). Deterministic per device+project,
 * so it's cheap to call repeatedly rather than caching it ourselves.
 */
async function currentPushToken(): Promise<string | null> {
  if (Platform.OS === 'web' || !Device.isDevice) return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return null;

  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

/** Whether this device already has push notifications for allotment results on. */
export async function isPushEnabled(): Promise<boolean> {
  const token = await currentPushToken();
  if (!token) return false;
  return hasPushToken(token);
}

/**
 * Register this device for allotment-result push notifications. Requires the
 * same OS permission as local reminders, plus a device that can actually
 * receive a push (a simulator/emulator without Google Play services cannot).
 */
export async function enablePushNotifications(userId: string): Promise<boolean> {
  if (!(await requestNotificationPermission())) return false;

  const token = await currentPushToken();
  if (!token) return false;

  await upsertPushToken(userId, token);
  return true;
}

export async function disablePushNotifications(): Promise<void> {
  const token = await currentPushToken();
  if (!token) return;
  await deletePushToken(token);
}
