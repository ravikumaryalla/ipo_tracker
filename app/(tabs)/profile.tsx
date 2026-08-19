import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import {
  AppHeader,
  Avatar,
  Banner,
  Button,
  Card,
  DonutGauge,
  ErrorText,
  Icon,
  Screen,
  type IconName,
} from '../../components/ui';
import { colors, formatInr, radius, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import {
  BIOMETRICS_WEB_MESSAGE,
  getBiometricSupport,
  type BiometricSupport,
} from '../../lib/crypto/secureStore';
import { listApplications, summarise } from '../../lib/db/applications';
import { listIpos } from '../../lib/db/ipos';
import {
  cancelAllReminders,
  disablePushNotifications,
  enablePushNotifications,
  isPushEnabled,
  syncReminders,
} from '../../lib/notifications';
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
  const { session, userId, signOut } = useAuth();
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
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const ipos = useQuery({ queryKey: ['ipos'], queryFn: listIpos });
  const applications = useQuery({ queryKey: ['applications'], queryFn: listApplications });

  const summary = useMemo(() => summarise(applications.data ?? []), [applications.data]);

  useEffect(() => {
    getBiometricSupport().then(setSupport).catch(() => undefined);
  }, []);

  useEffect(() => {
    isPushEnabled().then(setPushEnabled).catch(() => undefined);
  }, []);

  async function togglePush(next: boolean) {
    if (!userId) return;
    setError(null);
    setPushBusy(true);
    try {
      if (next) {
        const ok = await enablePushNotifications(userId);
        setPushEnabled(ok);
        setNotice(
          ok
            ? 'You will be notified when an allotment result is out.'
            : 'Could not enable push notifications on this device.',
        );
      } else {
        await disablePushNotifications();
        setPushEnabled(false);
        setNotice('Allotment result notifications are off.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change notification settings.');
    } finally {
      setPushBusy(false);
    }
  }

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
    <Screen inset header={<AppHeader title="Profile" />}>
      <ErrorText>{error}</ErrorText>
      {notice && <Banner tone="info">{notice}</Banner>}

      <View style={styles.identity}>
        <Avatar name={session?.user.email ?? '?'} size={56} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.identityName} numberOfLines={1}>
            {session?.user.email ?? 'Signed out'}
          </Text>
          <Text style={styles.identityMeta}>
            {summary.totalApplications} application(s) across {summary.byAccount.length} account(s)
          </Text>
        </View>
      </View>

      {/*
        The allotment gauge and the per-account breakdown came from the old
        dashboard when it was dissolved into Home and here. Home took the net
        position; these two need room to be read rather than glanced at, which
        is what this screen has.
      */}
      <Card>
        <SectionRow icon="pie" title="Portfolio" />

        <View style={styles.gaugeRow}>
          <DonutGauge value={summary.allotmentRate ?? 0} size={78} thickness={8}>
            <Text style={styles.gaugeText}>
              {summary.allotmentRate === null
                ? '—'
                : `${Math.round(summary.allotmentRate * 100)}%`}
            </Text>
          </DonutGauge>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.rowLabel}>Allotment rate</Text>
            <Text style={styles.rowHint}>
              {summary.allotmentRate === null
                ? 'No results yet.'
                : `${summary.allottedApplications} of ${summary.decidedApplications} decided application(s) were allotted.`}
            </Text>
          </View>
        </View>

        {summary.byAccount.length > 0 && (
          <View style={styles.byAccount}>
            {summary.byAccount.map((account, i) => (
              <View
                key={account.accountId}
                style={[
                  styles.accountRow,
                  i === summary.byAccount.length - 1 && styles.accountRowLast,
                ]}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.accountName} numberOfLines={1}>
                    {account.nickname}
                  </Text>
                  <Text style={styles.rowHint}>{account.applications} application(s)</Text>
                </View>
                {/* Fixed width so the rupee figures line up down the column —
                    tabular-nums is iOS-only, so the container does the work. */}
                <Text
                  style={[
                    styles.accountPnl,
                    {
                      color:
                        account.pnl > 0
                          ? colors.success
                          : account.pnl < 0
                            ? colors.danger
                            : colors.textMuted,
                    },
                  ]}
                  numberOfLines={1}
                >
                  {formatInr(account.pnl)}
                </Text>
              </View>
            ))}
          </View>
        )}
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

        <View style={[styles.switchRow, { marginTop: spacing.lg }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>Notify me when a result is out</Text>
            <Text style={styles.rowHint}>
              A push notification the moment an allotment result resolves for an IPO you applied
              to — even if the app is closed.
            </Text>
          </View>
          <Switch
            value={pushEnabled}
            onValueChange={togglePush}
            disabled={pushBusy || !userId}
            trackColor={{ true: colors.accent, false: colors.border }}
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
  const color = tone === 'danger' ? colors.danger : colors.accent;
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
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginBottom: spacing.xl,
  },
  identityName: { ...type.title, color: colors.text },
  identityMeta: { ...type.caption, color: colors.textMuted, marginTop: 2 },
  gaugeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  gaugeText: { ...type.bodyStrong, color: colors.text, fontSize: 15 },
  byAccount: { marginTop: spacing.lg },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  accountRowLast: { borderBottomWidth: 0 },
  accountName: { ...type.bodyStrong, color: colors.text },
  accountPnl: { ...type.bodyStrong, fontSize: 14, minWidth: 96, textAlign: 'right' },
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
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  sectionIconDanger: { backgroundColor: colors.dangerSoft },
  value: { ...type.body, color: colors.textMuted, fontSize: 14 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  rowLabel: { ...type.bodyStrong, color: colors.text, fontSize: 14 },
  rowHint: { ...type.caption, color: colors.textMuted, marginTop: spacing.xs },
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
