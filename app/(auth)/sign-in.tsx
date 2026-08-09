import { Link } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { BrandMark, Button, ErrorText, Field, Screen } from '../../components/ui';
import { colors, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';

export default function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
      // The route gate takes over from here.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <Screen style={styles.screen}>
        <BrandMark
          icon="ipos"
          title="Welcome back"
          subtitle="Your demat accounts and IPO applications, in one place."
        />

        <ErrorText>{error}</ErrorText>

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
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          placeholder="Your account password"
          onSubmitEditing={onSubmit}
          returnKeyType="go"
        />

        <Button title="Sign in" onPress={onSubmit} loading={busy} />

        <Link href="/(auth)/forgot-password" style={styles.forgot}>
          <Text style={styles.link}>Forgot your password?</Text>
        </Link>

        <View style={styles.footer}>
          <Text style={styles.footerText}>New here?</Text>
          <Link href="/(auth)/sign-up">
            <Text style={[styles.link, styles.linkStrong]}>Create an account</Text>
          </Link>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { justifyContent: 'center', minHeight: '100%', paddingHorizontal: spacing.xl },
  forgot: { alignSelf: 'center', marginBottom: spacing.xl },
  link: { ...type.body, color: colors.accentBright },
  linkStrong: { ...type.bodyStrong, color: colors.accentBright },
  footer: { flexDirection: 'row', gap: spacing.xs + 2, justifyContent: 'center' },
  footerText: { ...type.body, color: colors.textMuted },
});
