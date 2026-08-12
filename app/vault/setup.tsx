/**
 * First-run vault setup.
 *
 * Three steps, in this order on purpose:
 *   1. warn  — make the irreversibility impossible to miss, and require a tap
 *   2. set   — choose the PIN
 *   3. code  — show the recovery code exactly once
 *
 * The user cannot reach the app until step 3 is acknowledged, because that code
 * is the only way back in if the PIN is forgotten.
 */
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Banner, BrandMark, Button, Card, ErrorText, Field, Icon, Screen } from '../../components/ui';
import { colors, fonts, radius, spacing, type } from '../../constants/theme';
import { useVault } from '../../lib/vault';

type Step = 'warn' | 'set' | 'code';

export default function VaultSetup() {
  const { initialise } = useVault();
  const router = useRouter();

  const [step, setStep] = useState<Step>('warn');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The recovery code must not land in a screenshot or the app switcher preview.
  useEffect(() => {
    if (step !== 'code') return;
    ScreenCapture.preventScreenCaptureAsync().catch(() => undefined);
    return () => {
      ScreenCapture.allowScreenCaptureAsync().catch(() => undefined);
    };
  }, [step]);

  async function onCreate() {
    // The confirm field's "go" key can fire while a derivation is already
    // running; a second concurrent Argon2 run would double the stall.
    if (busy) return;
    setError(null);
    if (!/^\d{6}$/.test(passphrase)) return setError('Use a 6-digit PIN.');
    if (passphrase !== confirm) return setError('The two PINs do not match.');

    setBusy(true);
    try {
      const code = await initialise(passphrase);
      setRecoveryCode(code);
      setPassphrase('');
      setConfirm('');
      setStep('code');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set up your vault.');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'warn') {
    return (
      <Screen style={{ justifyContent: 'center', minHeight: '100%', paddingHorizontal: spacing.xl }}>
        <BrandMark
          icon="shield"
          title="Set up your vault"
          subtitle="One more code — this is the one that actually protects your demat logins."
        />

        <Card>
          <Text style={styles.point}>
            Your demat passwords are encrypted on this phone before they are saved. The server
            stores only scrambled data and never sees your PIN.
          </Text>
          <Text style={[styles.point, { color: colors.warning, fontFamily: fonts.bodySemi }]}>
            That also means nobody can reset it for you. If you forget this PIN and lose your
            recovery code, the stored passwords are gone for good.
          </Text>
          <Text style={styles.point}>
            Pick a PIN you will not forget, and keep the recovery code we show you next somewhere
            safe and offline.
          </Text>
        </Card>

        <Button title="I understand — continue" onPress={() => setStep('set')} />
      </Screen>
    );
  }

  if (step === 'set') {
    return (
      <Screen style={{ justifyContent: 'center', minHeight: '100%', paddingHorizontal: spacing.xl }}>
        <BrandMark
          icon="key"
          title="Choose your 6-digit PIN"
          subtitle="You will enter this to unlock your vault."
        />

        <ErrorText>{error}</ErrorText>

        <Field
          label="6-digit PIN"
          value={passphrase}
          onChangeText={(v) => setPassphrase(v.replace(/\D/g, '').slice(0, 6))}
          secureTextEntry
          keyboardType="number-pad"
          maxLength={6}
          placeholder="000000"
        />

        <Field
          label="Confirm PIN"
          value={confirm}
          onChangeText={(v) => setConfirm(v.replace(/\D/g, '').slice(0, 6))}
          secureTextEntry
          keyboardType="number-pad"
          maxLength={6}
          onSubmitEditing={onCreate}
        />

        <Button
          title={busy ? 'Encrypting…' : 'Create vault'}
          onPress={onCreate}
          loading={busy}
        />
        {busy && (
          <Text style={{ ...type.caption, color: colors.textFaint, textAlign: 'center' }}>
            Deriving your key. This takes a few seconds by design — it is what makes guessing your
            PIN expensive.
          </Text>
        )}
        <Button title="Back" variant="ghost" onPress={() => setStep('warn')} />
      </Screen>
    );
  }

  return (
    <Screen style={{ justifyContent: 'center', minHeight: '100%', paddingHorizontal: spacing.xl }}>
      <BrandMark
        icon="key"
        tone="warning"
        title="Your recovery code"
        subtitle="Write this down now. It is shown once and never again."
      />

      <Card style={{ alignItems: 'center', paddingVertical: spacing.xl }}>
        <Text selectable style={styles.code}>
          {recoveryCode}
        </Text>
      </Card>

      <Button
        title="Copy to clipboard"
        variant="secondary"
        onPress={() => Clipboard.setStringAsync(recoveryCode)}
      />

      <Banner tone="warning">
        This code can unlock your vault without the PIN. Treat it like the PIN itself: offline, on
        paper or in a different password manager — not in this app, and not in the same place you
        keep your phone.
      </Banner>

      <Pressable
        onPress={() => setSavedConfirmed((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg }}
      >
        <View style={[styles.checkbox, savedConfirmed && styles.checkboxOn]}>
          {savedConfirmed && <Icon name="check" size={16} color="#fff" />}
        </View>
        <Text style={{ ...type.body, color: colors.text, flex: 1 }}>
          I have written down my recovery code
        </Text>
      </Pressable>

      <Button
        title="Enter the app"
        disabled={!savedConfirmed}
        onPress={() => router.replace('/(tabs)')}
      />
    </Screen>
  );
}

const styles = {
  point: {
    ...type.body,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  code: {
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: 20,
    letterSpacing: 2,
    fontVariant: ['tabular-nums' as const],
    textAlign: 'center' as const,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  checkboxOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
};
