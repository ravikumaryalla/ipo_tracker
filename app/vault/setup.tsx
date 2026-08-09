/**
 * First-run vault setup.
 *
 * Three steps, in this order on purpose:
 *   1. warn  — make the irreversibility impossible to miss, and require a tap
 *   2. set   — choose the passphrase
 *   3. code  — show the recovery code exactly once
 *
 * The user cannot reach the app until step 3 is acknowledged, because that code
 * is the only way back in if the passphrase is forgotten.
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

/** Rough strength signal — length dominates, variety helps. Not a policy gate. */
function strengthOf(passphrase: string): { score: 0 | 1 | 2 | 3; label: string; tone: string } {
  const variety =
    Number(/[a-z]/.test(passphrase)) +
    Number(/[A-Z]/.test(passphrase)) +
    Number(/[0-9]/.test(passphrase)) +
    Number(/[^A-Za-z0-9]/.test(passphrase));

  if (passphrase.length < 10) return { score: 0, label: 'Too short', tone: colors.danger };
  if (passphrase.length >= 20 || (passphrase.length >= 16 && variety >= 3))
    return { score: 3, label: 'Strong', tone: colors.success };
  if (passphrase.length >= 14 || variety >= 3)
    return { score: 2, label: 'Good', tone: colors.warning };
  return { score: 1, label: 'Weak', tone: colors.warning };
}

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

  const strength = strengthOf(passphrase);

  async function onCreate() {
    setError(null);
    if (passphrase.length < 10) return setError('Use at least 10 characters.');
    if (passphrase !== confirm) return setError('The two passphrases do not match.');

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
          subtitle="One more password — this is the one that actually protects your demat logins."
        />

        <Card>
          <Text style={styles.point}>
            Your demat passwords are encrypted on this phone before they are saved. The server
            stores only scrambled data and never sees your master passphrase.
          </Text>
          <Text style={[styles.point, { color: colors.warning, fontFamily: fonts.bodySemi }]}>
            That also means nobody can reset it for you. If you forget this passphrase and lose your
            recovery code, the stored passwords are gone for good.
          </Text>
          <Text style={styles.point}>
            Pick something long that you will not forget, and keep the recovery code we show you
            next somewhere safe and offline.
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
          title="Choose your master passphrase"
          subtitle="Long beats complicated. A phrase of four or five unusual words works well."
        />

        <ErrorText>{error}</ErrorText>

        <Field
          label="Master passphrase"
          value={passphrase}
          onChangeText={setPassphrase}
          secureTextEntry
          autoCapitalize="none"
          placeholder="At least 10 characters"
        />
        {passphrase.length > 0 && (
          <Text style={{ ...type.caption, color: strength.tone, fontSize: 13, marginTop: -spacing.md, marginBottom: spacing.lg }}>
            {strength.label}
          </Text>
        )}

        <Field
          label="Confirm passphrase"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          autoCapitalize="none"
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
            passphrase expensive.
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
        This code can unlock your vault without the passphrase. Treat it like the passphrase itself:
        offline, on paper or in a different password manager — not in this app, and not in the same
        place you keep your phone.
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
