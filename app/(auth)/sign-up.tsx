import { Link, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';

import { Banner, BrandMark, Button, ErrorText, Field, Screen } from '../../components/ui';
import { colors, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';

export default function SignUp() {
  const { signUp } = useAuth();
  const router = useRouter();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    if (!email.trim()) return setError('Enter your email.');
    if (password.length < 8) return setError('Use at least 8 characters for your account password.');
    if (password !== confirm) return setError('The two passwords do not match.');

    setBusy(true);
    try {
      const { needsEmailConfirmation } = await signUp(email, password, displayName || email);
      if (needsEmailConfirmation) setSent(true);
      // Otherwise the route gate moves us straight to vault setup.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create your account.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Screen style={{ justifyContent: 'center', minHeight: '100%', paddingHorizontal: spacing.xl }}>
        <BrandMark
          icon="check"
          tone="success"
          title="Check your email"
          subtitle={`We sent a confirmation link to ${email}. Open it, then come back and sign in.`}
        />
        <Button title="Back to sign in" onPress={() => router.replace('/(auth)/sign-in')} />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <Screen style={{ justifyContent: 'center', minHeight: '100%', paddingHorizontal: spacing.xl }}>
        <BrandMark
          icon="accounts"
          title="Create your account"
          subtitle="One account holds every demat login and IPO application."
        />

        <Banner tone="info">
          This password signs you in. In the next step you will set a separate master passphrase
          that encrypts your demat passwords — they are deliberately kept apart.
        </Banner>

        <ErrorText>{error}</ErrorText>

        <Field
          label="Name"
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Ravi"
          autoComplete="name"
        />
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
        />
        <Field
          label="Account password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          hint="At least 8 characters."
        />
        <Field
          label="Confirm password"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          onSubmitEditing={onSubmit}
          returnKeyType="go"
        />

        <Button title="Create account" onPress={onSubmit} loading={busy} />

        <View style={{ flexDirection: 'row', gap: spacing.xs }}>
          <Text style={{ ...type.body, color: colors.textMuted }}>Already have an account?</Text>
          <Link href="/(auth)/sign-in">
            <Text style={{ ...type.bodyStrong, color: colors.accentBright }}>Sign in</Text>
          </Link>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}
