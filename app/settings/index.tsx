import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Banner, Button, Card, ErrorText, Icon, Screen, type IconName } from '../../components/ui';
import { colors, radius, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import {
  BIOMETRICS_WEB_MESSAGE,
  getBiometricSupport,
  type BiometricSupport,
} from '../../lib/crypto/secureStore';
import { listApplications } from '../../lib/db/applications';
import { listIpos } from '../../lib/db/ipos';
import { cancelAllReminders, syncReminders } from '../../lib/notifications';
import { useVault } from '../../lib/vault';

const AUTO_LOCK_CHOICES = [
  { minutes: 1, label: '1 min' },
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 0, label: 'Never' },
];

export default function Settings() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const {
    autoLockMinutes,
    setAutoLockMinutes,
    biometricsEnabled,
    enableBiometrics,
    disableBiometrics,
    lock,
  } = useVault();

  const [support, setSupport] = useState<BiometricSupport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ipos = useQuery({ queryKey: ['ipos'], queryFn: listIpos });
  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });

  useEffect(() => {
    getBiometricSupport().then(setSupport).catch(() => undefined);
  }, []);

  async function toggleBiometrics(next: boolean) {
    setError(null);
    setBusy(true);
    try {
      if (next) {
        await enableBiometrics();
        setNotice('Biometric unlock is on.');
      } else {
        await disableBiometrics();
        setNotice('Biometric unlock is off. You will need your PIN each time.');
      }
    } catch (e) {
      // Most likely the OEM refused a Keystore entry gated on authentication.
      // We do not fall back to storing the key unguarded — see secureStore.ts.
      setError(
        e instanceof Error
          ? `Could not turn on biometric unlock: ${e.message}`
          : 'Could not change biometric unlock.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function rescheduleReminders() {
    setError(null);
    setBusy(true);
    try {
      const appliedIpoIds = new Set((applications.data ?? []).map((a) => a.ipo_id));
      const count = await syncReminders(ipos.data ?? [], appliedIpoIds);
      setNotice(
        count > 0
          ? `Scheduled ${count} reminder(s).`
          : 'No reminders to schedule — either notifications are off, or no upcoming dates.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not schedule reminders.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ErrorText>{error}</ErrorText>
      {notice && <Banner tone="info">{notice}</Banner>}

      <Card>
        <SectionRow icon="accounts" title="Account" />
        <Text style={styles.value}>{session?.user.email}</Text>
      </Card>

      <Card>
        <SectionRow icon="shield" title="Vault" />

        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>
              Unlock with {support?.label.toLowerCase() ?? 'biometrics'}
            </Text>
            <Text style={styles.rowHint}>
              {Platform.OS === 'web'
                ? BIOMETRICS_WEB_MESSAGE
                : support?.enrolled
                  ? 'Stores your vault key in the Android Keystore, released only after you unlock your device.'
                  : 'Set up a fingerprint, face, or PIN/pattern lock on your phone first.'}
            </Text>
          </View>
          <Switch
            value={biometricsEnabled}
            onValueChange={toggleBiometrics}
            disabled={busy || !support?.enrolled}
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </View>

        <Text style={[styles.rowLabel, { marginTop: spacing.lg }]}>Lock after inactivity</Text>
        <Text style={styles.rowHint}>
          Checked when the app returns to the foreground.
        </Text>
        <View style={styles.chipRow}>
          {AUTO_LOCK_CHOICES.map((choice) => (
            <Pressable
              key={choice.minutes}
              onPress={() => setAutoLockMinutes(choice.minutes)}
              style={[styles.chip, choice.minutes === autoLockMinutes && styles.chipOn]}
            >
              <Text
                style={[
                  styles.chipText,
                  choice.minutes === autoLockMinutes && styles.chipTextOn,
                ]}
              >
                {choice.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={{ marginTop: spacing.lg }}>
          <Button title="Lock vault now" icon="lock" variant="secondary" onPress={lock} />
          <Button
            title="Change PIN"
            variant="secondary"
            onPress={() => router.push('/settings/change-pin')}
          />
        </View>
      </Card>

      <Card>
        <SectionRow icon="calendar" title="Reminders" />
        <Text style={styles.rowHint}>
          Local notifications for closing dates on IPOs you have not applied to, and for allotment
          and listing dates on the ones you have.
        </Text>
        <View style={{ marginTop: spacing.md }}>
          <Button title="Reschedule reminders" onPress={rescheduleReminders} loading={busy} />
          <Button
            title="Cancel all reminders"
            variant="ghost"
            onPress={async () => {
              await cancelAllReminders();
              setNotice('All reminders cancelled.');
            }}
          />
        </View>
      </Card>

      <Card>
        <SectionRow icon="warning" title="Danger zone" tone="danger" />
        <Button
          title="Sign out"
          variant="danger"
          onPress={() =>
            Alert.alert('Sign out?', 'Your cached vault key will be erased from this device.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
            ])
          }
        />
      </Card>
    </Screen>
  );
}


function SectionRow({
  icon,
  title,
  tone = 'normal',
}: {
  icon: IconName;
  title: string;
  tone?: 'normal' | 'danger';
}) {
  const color = tone === 'danger' ? colors.danger : colors.accentBright;
  return (
    <View style={styles.sectionRow}>
      <View style={[styles.sectionIcon, tone === 'danger' && styles.sectionIconDanger]}>
        <Icon name={icon} size={16} color={color} />
      </View>
      <Text style={[styles.section, tone === 'danger' && { color: colors.danger }]}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { ...type.heading, color: colors.text },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  sectionIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  sectionIconDanger: { backgroundColor: colors.dangerSoft },
  value: { ...type.body, color: colors.textMuted, fontSize: 14 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  rowLabel: { ...type.bodyStrong, color: colors.text, fontSize: 14 },
  rowHint: { ...type.caption, color: colors.textFaint, marginTop: spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: { ...type.label, color: colors.textMuted, fontSize: 12, letterSpacing: 0.2 },
  chipTextOn: { color: colors.accent },
});
