/**
 * The lock screen. Reached on cold start, after auto-lock, and after a manual
 * lock. Offers biometrics when they are set up, PIN always, and the recovery
 * code as the last resort.
 *
 * This is the screen the app shows most often, so it leads with who you are
 * rather than with product chrome: an avatar, a greeting, and an escape hatch
 * for the case where the answer is "that isn't me".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Avatar,
  Banner,
  Button,
  ErrorText,
  Field,
  PinInput,
  Screen,
} from '../../components/ui';
import { colors, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { getBiometricSupport, type BiometricSupport } from '../../lib/crypto/secureStore';
import { useVault } from '../../lib/vault';

/**
 * The name to greet by.
 *
 * `display_name` is set on the auth user at sign-up (lib/auth.tsx), so it is
 * already in memory — a locked screen must not need a query to render. Sign-up
 * falls back to the email when the name field is left blank, so the stored
 * value can itself be an address; take the local part in that case rather than
 * greeting someone by their full email.
 */
function greetingName(displayName: unknown, email: string | undefined): string {
  const candidate =
    (typeof displayName === 'string' && displayName.trim()) || email?.trim() || '';
  if (!candidate) return 'there';
  const local = candidate.includes('@') ? candidate.split('@')[0] : candidate;
  if (!local) return 'there';
  // An email local part arrives lowercase, and "Hey, ravikumar" reads like a
  // username rather than a greeting. Only the first letter is touched — the
  // rest is left exactly as typed, so "McDonald" survives.
  return local[0].toUpperCase() + local.slice(1);
}

export default function VaultUnlock() {
  const { unlock, unlockWithBiometrics, unlockWithRecoveryCode, biometricsEnabled } = useVault();
  const { session, signOut } = useAuth();

  const [passphrase, setPassphrase] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);
  const [support, setSupport] = useState<BiometricSupport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  // Mirrored in a ref so tryBiometrics can check it without depending on the
  // state value — a `busy` dep would change its identity and retrigger the
  // auto-prompt effect below.
  const busyRef = useRef(false);
  const setBusy = (value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  };

  const email = session?.user.email;
  const name = greetingName(session?.user.user_metadata?.display_name, email);

  useEffect(() => {
    getBiometricSupport().then(setSupport).catch(() => undefined);
  }, []);

  // Every unlock path re-checks `busy`: the keyboard "go" key and the buttons
  // can fire while a derivation is already running, and a second concurrent
  // Argon2 run means another multi-second stall and a 64 MiB allocation.
  const tryBiometrics = useCallback(async () => {
    if (busyRef.current) return;
    setError(null);
    setBusy(true);
    try {
      const ok = await unlockWithBiometrics();
      if (!ok) setError('Biometric unlock did not work. Use your PIN.');
    } finally {
      setBusy(false);
    }
  }, [unlockWithBiometrics]);

  // Offer the prompt immediately when biometrics are set up — that is the whole
  // point of the feature; making the user tap first would defeat it.
  useEffect(() => {
    if (biometricsEnabled && support?.enrolled) tryBiometrics();
    // Intentionally runs once when both become known.
  }, [biometricsEnabled, support?.enrolled, tryBiometrics]);

  async function onUnlock() {
    if (busy) return;
    setError(null);
    if (!passphrase) return setError('Enter your PIN.');
    setBusy(true);
    try {
      await unlock(passphrase);
      setPassphrase('');
    } catch (e) {
      // Clear the box on a bad PIN: leaving the six filled slots there reads as
      // "that went through", and the next digit typed would append to a full
      // field and do nothing.
      setPassphrase('');
      setError(e instanceof Error ? e.message : 'Could not unlock.');
    } finally {
      setBusy(false);
    }
  }

  async function onRecover() {
    if (busy) return;
    setError(null);
    if (!recoveryCode.trim()) return setError('Enter your recovery code.');
    setBusy(true);
    try {
      await unlockWithRecoveryCode(recoveryCode);
      setRecoveryCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not unlock.');
    } finally {
      setBusy(false);
    }
  }

  // Confirmed, because this sits directly under the greeting where a mis-tap is
  // easy and signing out clears the cached vault key and this device's push
  // token.
  function confirmSignOut() {
    Alert.alert(
      'Sign out?',
      'Your cached vault key will be erased from this device. You will need your PIN or recovery code to unlock again after signing back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
      ],
    );
  }

  // Only paddingHorizontal is passed to Screen: it applies the caller's style
  // after its own paddingTop, so overriding that would put this content under
  // the status bar on a notched device. The breathing room goes on the avatar.
  return (
    <Screen style={{ paddingHorizontal: spacing.xl }}>
      <Avatar name={name} size={64} style={styles.avatar} />

      <Text style={styles.greeting}>Hey, {name}</Text>
      {email ? (
        <Pressable accessibilityRole="button" onPress={confirmSignOut} hitSlop={8}>
          <Text style={styles.notYou}>Not {email}?</Text>
        </Pressable>
      ) : null}

      <View style={styles.body}>
        <ErrorText>{error}</ErrorText>

        {showRecovery ? (
          <>
            <Banner tone="warning">
              Use this only if you have forgotten your PIN. After unlocking, set a new PIN in
              Settings.
            </Banner>
            <Field
              label="Recovery code"
              value={recoveryCode}
              onChangeText={setRecoveryCode}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            />
            <Button title="Unlock with recovery code" onPress={onRecover} loading={busy} />
            <Button title="Back" variant="ghost" onPress={() => setShowRecovery(false)} />
          </>
        ) : (
          <>
            <Text style={styles.prompt}>Enter your 6-digit PIN.</Text>

            <PinInput
              value={passphrase}
              onChangeText={setPassphrase}
              autoFocus={!biometricsEnabled}
              onSubmitEditing={onUnlock}
            />

            <Button
              title={busy ? 'Unlocking…' : 'Continue'}
              onPress={onUnlock}
              loading={busy}
            />

            {biometricsEnabled && support?.enrolled && (
              <Button
                title={`Use ${support.label.toLowerCase()}`}
                icon={support.label === 'Device passcode' ? 'lock' : 'fingerprint'}
                variant="secondary"
                onPress={tryBiometrics}
                disabled={busy}
              />
            )}

            <Button
              title="I forgot my PIN"
              variant="ghost"
              onPress={() => setShowRecovery(true)}
            />
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: { marginTop: spacing.xl },
  greeting: { ...type.display, color: colors.text, marginTop: spacing.lg },
  notYou: { ...type.body, color: colors.accent, marginTop: spacing.xs },
  body: { marginTop: spacing.xl },
  prompt: { ...type.body, color: colors.text, marginBottom: spacing.md },
});
