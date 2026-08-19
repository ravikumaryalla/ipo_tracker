import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Heading,
  ListRow,
  Loading,
  Screen,
} from '../../components/ui';
import { colors, spacing, type } from '../../constants/theme';
import { listBrokers } from '../../lib/db/brokers';
import { listAccountSummaries } from '../../lib/db/accounts';

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
    <Screen inset>
      <Heading
        sub={
          total > 0
            ? `${total} demat account${total === 1 ? '' : 's'}, credentials encrypted on this device.`
            : 'Credentials are encrypted on this device before they ever leave it.'
        }
      >
        Accounts
      </Heading>

      <ErrorText>{accounts.error instanceof Error ? accounts.error.message : null}</ErrorText>

      <Button title="Add demat account" icon="add" onPress={() => router.push('/accounts/new')} />

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

          return (
            <ListRow
              key={account.id}
              index={i}
              icon="accounts"
              accent={
                !account.is_active
                  ? colors.textFaint
                  : stale
                    ? colors.warning
                    : colors.accent
              }
              title={account.nickname}
              subtitle={brokerName(account.broker_id)}
              onPress={() => router.push(`/accounts/${account.id}`)}
              right={
                <View style={styles.tags}>
                  {!account.is_active && <Badge label="Inactive" tone="muted" />}
                  {stale && <Badge label={`${age}d old`} tone="warning" />}
                </View>
              }
            />
          );
        })
      )}

      {total > 0 && (
        <Text style={styles.footnote}>
          Passwords older than a year are flagged. Tap an account to rotate its credentials.
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tags: { alignItems: 'flex-end', gap: spacing.xs },
  footnote: {
    ...type.caption,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
  },
});
