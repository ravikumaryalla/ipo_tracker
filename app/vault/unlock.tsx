/**
 * The lock screen. Reached on cold start, after auto-lock, and after a manual
 * lock. Offers biometrics when they are set up, PIN always, and the recovery
 * code as the last resort.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { Banner, BrandMark, Button, ErrorText, Field, Screen } from '../../components/ui';
import { colors, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { getBiometricSupport, type BiometricSupport } from '../../lib/crypto/secureStore';
import { useVault } from '../../lib/vault';

export default function VaultUnlock() {
  const { unlock, unlockWithBiometrics, unlockWithRecoveryCode, biometricsEnabled } = useVault();
  const { signOut } = useAuth();

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

  return (
    <Screen style={{ justifyContent: 'center', minHeight: '100%', paddingHorizontal: spacing.xl }}>
      <BrandMark
        icon="lock"
        title="Vault locked"
        subtitle="Your passwords stay encrypted until you unlock them."
      />

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
          <Field
            label="PIN"
            value={passphrase}
            onChangeText={(v) => setPassphrase(v.replace(/\D/g, '').slice(0, 6))}
            secureTextEntry
            keyboardType="number-pad"
            maxLength={6}
            autoFocus={!biometricsEnabled}
            onSubmitEditing={onUnlock}
            returnKeyType="go"
          />

          <Button
            title={busy ? 'Unlocking…' : 'Unlock'}
            icon="unlock"
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

      <View style={{ marginTop: spacing.xl, alignItems: 'center' }}>
        <Text style={{ ...type.caption, color: colors.textFaint, marginBottom: spacing.sm }}>
          Signed in on the wrong account?
        </Text>
        <Button title="Sign out" variant="ghost" onPress={() => signOut()} />
      </View>
    </Screen>
  );
}
