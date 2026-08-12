/**
 * Device-side storage for the vault key.
 *
 * expo-secure-store keeps values in the Android Keystore (Keychain on iOS), so
 * the cached key is encrypted at rest by hardware-backed keys and is not
 * readable by other apps or by an adb backup.
 *
 * The cached key is a convenience only: it lets biometrics stand in for
 * retyping the PIN. It is always erasable, and sign-out wipes it.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { fromBase64, toBase64 } from './primitives';

const VAULT_KEY_SLOT = 'ipo_tracker.vault_key';
const BIOMETRICS_ENABLED_SLOT = 'ipo_tracker.biometrics_enabled';

/**
 * expo-secure-store has NO web implementation — its web stub is `export default
 * {}`, so every call here would throw a TypeError in the browser. Since
 * `isBiometricUnlockEnabled()` runs during `loadProfile()` on every app start,
 * an unguarded call leaves the vault stuck at status 'loading' and the whole
 * app hangs on a spinner.
 *
 * On web we therefore report "no biometrics, nothing cached" and refuse to
 * store the key at all. A browser has no Keystore equivalent, and localStorage
 * would mean writing the vault key to disk in plaintext — exactly what this
 * app exists to avoid. Web preview is PIN-only by design.
 */
const isWeb = Platform.OS === 'web';

export const BIOMETRICS_WEB_MESSAGE =
  'Biometric unlock needs a real Android build — it is not available in the web preview.';

/** What kind of unlock the device can offer, so the UI can label the button. */
export type BiometricSupport = {
  available: boolean;
  enrolled: boolean;
  label: 'Fingerprint' | 'Face' | 'Device passcode' | 'Biometrics';
};

export async function getBiometricSupport(): Promise<BiometricSupport> {
  if (isWeb) return { available: false, enrolled: false, label: 'Biometrics' };

  const [hasHardware, enrolled, types, enrolledLevel] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
    LocalAuthentication.getEnrolledLevelAsync(),
  ]);

  // hasHardwareAsync/isEnrolledAsync only ever report a fingerprint/face
  // scanner — a device locked with just a PIN or pattern (no biometric
  // sensor at all) fails both, even though authenticateAsync() already
  // happily prompts for that PIN via its device-credential fallback. Without
  // this, PIN-only devices could never enable or use this unlock method at
  // all, not even as the "Device passcode" case the label logic below
  // already anticipates.
  const hasDeviceCredential = enrolledLevel >= LocalAuthentication.SecurityLevel.SECRET;

  let label: BiometricSupport['label'] = 'Biometrics';
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) label = 'Face';
  else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) label = 'Fingerprint';
  else if (!hasHardware) label = 'Device passcode';

  return {
    available: hasHardware || hasDeviceCredential,
    enrolled: enrolled || hasDeviceCredential,
    label,
  };
}

/** Prompt for fingerprint/face. Falls back to the device PIN if biometrics fail. */
export async function authenticateWithBiometrics(reason = 'Unlock your vault'): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: 'Use PIN',
    disableDeviceFallback: false,
  });
  return result.success;
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  if (isWeb) return false;
  return (await SecureStore.getItemAsync(BIOMETRICS_ENABLED_SLOT)) === 'true';
}

/**
 * Cache the vault key so future unlocks can use biometrics.
 *
 * `requireAuthentication` asks the platform to gate the Keystore entry behind a
 * biometric prompt. Some Android OEMs reject that flag; if it fails we do NOT
 * silently downgrade to an unguarded write, because that would store the key
 * where a device-level compromise reads it without a prompt. We surface the
 * failure and leave biometric unlock switched off instead.
 */
export async function cacheVaultKey(key: Uint8Array): Promise<void> {
  // Throw rather than no-op: app/settings/index.tsx catches this and shows the
  // reason, which beats a toggle that flips and silently does nothing.
  if (isWeb) throw new Error(BIOMETRICS_WEB_MESSAGE);

  await SecureStore.setItemAsync(VAULT_KEY_SLOT, toBase64(key), {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(BIOMETRICS_ENABLED_SLOT, 'true');
}

/**
 * Read the cached vault key. Returns null when biometric unlock was never set
 * up, the user cancelled, or the OS invalidated the entry (which Android does
 * when a new fingerprint is enrolled — a deliberate security property).
 */
export async function readCachedVaultKey(): Promise<Uint8Array | null> {
  if (isWeb) return null;

  try {
    const stored = await SecureStore.getItemAsync(VAULT_KEY_SLOT, {
      requireAuthentication: true,
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return stored ? fromBase64(stored) : null;
  } catch {
    // Cancelled prompt or invalidated key — the PIN path still works.
    return null;
  }
}

/** Remove the cached key. Called on sign-out, on lock-out, and from settings. */
export async function clearCachedVaultKey(): Promise<void> {
  if (isWeb) return; // nothing was ever cached

  await Promise.all([
    SecureStore.deleteItemAsync(VAULT_KEY_SLOT).catch(() => undefined),
    SecureStore.deleteItemAsync(BIOMETRICS_ENABLED_SLOT).catch(() => undefined),
  ]);
}
