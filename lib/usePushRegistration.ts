/**
 * Keeps this device's push-token row current for the signed-in user.
 *
 * Two things the old "flip the Profile switch" flow never did:
 *  - registers silently on every sign-in, so a reinstall or a second phone
 *    starts getting allotment pushes without visiting Settings (no-op until the
 *    OS permission has been granted once — see registerPushTokenSilently);
 *  - follows OS push-token rotation via addPushTokenListener, so a rotated token
 *    does not silently stop delivering.
 *
 * Mounted once in RouteGate. No teardown here: sign-out already deletes this
 * device's row in lib/auth.tsx#signOut while the session is still valid.
 */
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { upsertPushToken } from './db/pushTokens';
import { registerPushTokenSilently } from './notifications';

export function usePushRegistration(userId: string | null): void {
  useEffect(() => {
    if (!userId) return;

    registerPushTokenSilently(userId).catch(() => undefined);

    const sub = Notifications.addPushTokenListener((event) => {
      const token = typeof event.data === 'string' ? event.data : null;
      if (!token) return;
      upsertPushToken(userId, token, { platform: Platform.OS }).catch(() => undefined);
    });
    return () => sub.remove();
  }, [userId]);
}
