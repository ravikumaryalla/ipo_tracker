import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { Banner, BrandMark, Button, ErrorText, Field, Screen } from '../../components/ui';
import { spacing } from '../../constants/theme';
import { useAuth } from '../../lib/auth';

export default function ForgotPassword() {
  const { sendPasswordReset } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    if (!email.trim()) return setError('Enter the email you signed up with.');
    setBusy(true);
    try {
      await sendPasswordReset(email);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the reset email.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen style={{ justifyContent: 'center', minHeight: '100%', paddingHorizontal: spacing.xl }}>
      <BrandMark
        icon="key"
        tone="warning"
        title="Reset your password"
        subtitle="We'll email you a link to set a new sign-in password."
      />

      <Banner tone="warning">
        This resets your sign-in password only. Your master passphrase is never sent to the server,
        so it cannot be reset this way — use your recovery code if you have lost it.
      </Banner>

      {sent ? (
        <>
          <Banner tone="info">If an account exists for {email}, the link is on its way.</Banner>
          <Button title="Back to sign in" onPress={() => router.replace('/(auth)/sign-in')} />
        </>
      ) : (
        <>
          <ErrorText>{error}</ErrorText>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="you@example.com"
            onSubmitEditing={onSubmit}
          />
          <Button title="Send reset link" onPress={onSubmit} loading={busy} />
          <Button title="Back" variant="ghost" onPress={() => router.back()} />
        </>
      )}
    </Screen>
  );
}
