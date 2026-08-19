/**
 * Demat accounts.
 *
 * This list is built from `listAccountSummaries`, which returns labels only and
 * so renders while the vault is still locked. The credentials themselves — DP
 * ID, client ID, bank, UPI, password, MPIN — live behind decryption and are
 * shown on the detail screen. That split is deliberate: a locked vault should
 * still let you see which accounts exist.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import {
  AppHeader,
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorText,
  HeaderAction,
  Icon,
  Loading,
  Screen,
} from '../../components/ui';
import { colors, motion, spacing, type } from '../../constants/theme';
import { listAccountSummaries } from '../../lib/db/accounts';
import { listBrokers } from '../../lib/db/brokers';

/** Warn when a password has gone a year without a change. */
const STALE_PASSWORD_DAYS = 365;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export default function AccountsTab() {
  const router = useRouter();

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: listAccountSummaries });
  const brokers = useQuery({ queryKey: ['brokers'], queryFn: listBrokers });

  const brokerName = (id: string | null) =>
    brokers.data?.find((b) => b.id === id)?.name ?? 'Unknown broker';

  if (accounts.isLoading) return <Loading label="Loading accounts…" />;

  const total = accounts.data?.length ?? 0;

  return (
    <Screen
      inset
      header={
        <AppHeader
          title="Demat Accounts"
          right={
            <HeaderAction
              icon="add"
              label="Add demat account"
              color={colors.accent}
              onPress={() => router.push('/accounts/new')}
            />
          }
        />
      }
    >
      <ErrorText>{accounts.error instanceof Error ? accounts.error.message : null}</ErrorText>

      {total === 0 ? (
        <EmptyState
          icon="accounts"
          title="No accounts yet"
          body="Add your first demat account to start tracking its credentials and IPO applications."
        />
      ) : (
        accounts.data?.map((account, i) => {
          const age = daysSince(account.password_changed_at);
          const stale = age !== null && age > STALE_PASSWORD_DAYS;
          const broker = brokerName(account.broker_id);

          return (
            <Animated.View
              key={account.id}
              entering={FadeInDown.delay(i * motion.stagger).duration(motion.base)}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={account.nickname}
                onPress={() => router.push(`/accounts/${account.id}`)}
              >
                <Card elevation={1}>
                  <View style={styles.head}>
                    <Avatar
                      name={broker}
                      size={40}
                      color={account.is_active ? undefined : colors.textFaint}
                    />
                    <View style={styles.headText}>
                      <Text style={styles.name} numberOfLines={1}>
                        {account.nickname}
                      </Text>
                      <Text style={styles.broker} numberOfLines={1}>
                        {broker}
                      </Text>
                    </View>
                    <View style={styles.tags}>
                      {!account.is_active && (
                        <Badge label="Inactive" tone="muted" variant="filled" size="small" />
                      )}
                      {stale && (
                        <Badge
                          label={`${age}d old`}
                          tone="warning"
                          variant="filled"
                          size="small"
                        />
                      )}
                    </View>
                    <Icon name="chevron" size={18} color={colors.textFaint} />
                  </View>
                </Card>
              </Pressable>
            </Animated.View>
          );
        })
      )}

      {total > 0 && (
        <Text style={styles.footnote}>
          Credentials are encrypted on this device before they ever leave it. Passwords older than
          a year are flagged — tap an account to rotate them.
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headText: { flex: 1, minWidth: 0 },
  name: { ...type.heading, color: colors.text },
  broker: { ...type.caption, color: colors.textMuted, marginTop: 1 },
  tags: { alignItems: 'flex-end', gap: spacing.xs },
  footnote: {
    ...type.caption,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
  },
});
