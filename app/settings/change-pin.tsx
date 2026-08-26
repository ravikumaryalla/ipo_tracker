/**
 * Change the vault PIN.
 *
 * This re-encrypts every stored credential on the device under a new key, so it
 * is genuinely destructive if interrupted — the screen says so, and the vault
 * layer rewrites the data before swapping the profile's salt so a failure
 * mid-way is recoverable by retrying.
 */
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { Banner, Button, Card, ErrorText, Heading, PinInput, Screen } from '../../components/ui';
import { colors, fonts, spacing } from '../../constants/theme';
import { useVault } from '../../lib/vault';

export default function ChangePin() {
  const { changePassphrase } = useVault();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [newCode, setNewCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!newCode) return;
    ScreenCapture.preventScreenCaptureAsync().catch(() => undefined);
    return () => {
      ScreenCapture.allowScreenCaptureAsync().catch(() => undefined);
    };
  }, [newCode]);

  async function onSubmit() {
    if (busy) return;
    setError(null);
    if (!current) return setError('Enter your current PIN.');
    if (!/^\d{6}$/.test(next)) return setError('The new PIN must be 6 digits.');
    if (next !== confirm) return setError('The two new PINs do not match.');
    if (next === current) return setError('The new PIN is the same as the current one.');

    setBusy(true);
    try {
      const code = await changePassphrase(current, next);
      // Decrypted rows in the cache were encrypted under the old key.
      await queryClient.invalidateQueries();
      setCurrent('');
      setNext('');
      setConfirm('');
      setNewCode(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change your PIN.');
    } finally {
      setBusy(false);
    }
  }

  if (newCode) {
    return (
      <Screen>
        <Heading sub="Your PIN has been changed and every stored credential re-encrypted.">
          Done
        </Heading>

        <Card style={{ alignItems: 'center', paddingVertical: spacing.xl }}>
          <Text selectable style={styles.code}>
            {newCode}
          </Text>
        </Card>

        <Button
          title="Copy to clipboard"
          variant="secondary"
          onPress={() => Clipboard.setStringAsync(newCode)}
        />

        <Banner tone="warning">
          This replaces your old recovery code, which no longer works. Write this one down before
          you leave this screen.
        </Banner>

        <Button title="Back to settings" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading sub="Every stored credential is decrypted and re-encrypted under the new PIN.">
        Change PIN
      </Heading>

      <Banner tone="warning">
        Stay on this screen until it finishes. If it is interrupted partway, sign back in and run it
        again with the same current PIN — your data is not lost, but the retry is required.
      </Banner>

      <ErrorText>{error}</ErrorText>

      <PinInput label="Current PIN" value={current} onChangeText={setCurrent} />
      <PinInput label="New PIN" value={next} onChangeText={setNext} hint="6 digits." />
      <PinInput label="Confirm new PIN" value={confirm} onChangeText={setConfirm} />

      <Button
        title={busy ? 'Re-encrypting…' : 'Change PIN'}
        onPress={onSubmit}
        loading={busy}
      />
      <Button title="Cancel" variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = {
  code: {
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: 20,
    letterSpacing: 2,
    textAlign: 'center' as const,
  },
};
