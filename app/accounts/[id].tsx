/**
 * Account detail: read the credentials, or switch to editing them.
 *
 * The decrypted account is fetched with the vault key and kept in the query
 * cache under a key that includes 'decrypted' — invalidated on lock so a
 * re-lock cannot leave plaintext sitting in the cache.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { AccountForm } from '../../components/AccountForm';
import { SecretField } from '../../components/SecretField';
import { Badge, Button, Card, ErrorText, Loading, Screen } from '../../components/ui';
import { colors, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { deleteAccount, getAccount, updateAccount } from '../../lib/db/accounts';
import { listBrokers } from '../../lib/db/brokers';
import { requireKey, useVault } from '../../lib/vault';

export default function AccountDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userId } = useAuth();
  const { getKey, status } = useVault();

  const [editing, setEditing] = useState(false);

  const account = useQuery({
    queryKey: ['account', id, 'decrypted'],
    // Only run while unlocked — there is no key to decrypt with otherwise.
    enabled: status === 'unlocked' && Boolean(id),
    queryFn: () => getAccount(requireKey(getKey), id!),
  });

  const brokers = useQuery({ queryKey: ['brokers'], queryFn: listBrokers });

  const remove = useMutation({
    mutationFn: () => deleteAccount(id!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      router.back();
    },
  });

  function confirmDelete() {
    Alert.alert(
      'Delete this account?',
      'The stored credentials and this account\'s IPO applications will be permanently removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => remove.mutate() },
      ],
    );
  }

  if (status !== 'unlocked') return <Loading label="Waiting for the vault…" />;
  if (account.isLoading) return <Loading label="Decrypting…" />;
  if (account.error) {
    return (
      <Screen>
        <ErrorText>
          {account.error instanceof Error ? account.error.message : 'Could not load this account.'}
        </ErrorText>
      </Screen>
    );
  }

  const data = account.data!;
  const brokerName = brokers.data?.find((b) => b.id === data.broker_id)?.name;

  if (editing) {
    return (
      <Screen>
        <AccountForm
          brokers={brokers.data ?? []}
          initial={data}
          submitLabel="Save changes"
          onSubmit={async (input) => {
            if (!userId) throw new Error('Not signed in.');
            await updateAccount(requireKey(getKey), userId, id!, input);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['account', id, 'decrypted'] }),
              queryClient.invalidateQueries({ queryKey: ['accounts'] }),
            ]);
            setEditing(false);
          }}
          onDelete={confirmDelete}
        />
        <Button title="Cancel" variant="ghost" onPress={() => setEditing(false)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{data.nickname}</Text>
          {brokerName ? <Text style={styles.subtitle}>{brokerName}</Text> : null}
        </View>
        {!data.is_active && <Badge label="INACTIVE" tone="muted" />}
      </View>

      <Card>
        <SecretField label="Client ID" value={data.client_id} monospace />
        <SecretField label="DP ID" value={data.dp_id} monospace />
        <SecretField label="BO ID" value={data.bo_id} monospace />
      </Card>

      <Card>
        <SecretField label="Email" value={data.email} />
        <SecretField label="Phone number" value={data.phone} />
        <SecretField label="Password" value={data.password} />
        <SecretField label="MPIN" value={data.mpin} />
        {data.password_changed_at && (
          <Text style={styles.meta}>
            Password last changed {new Date(data.password_changed_at).toLocaleDateString('en-IN')}
          </Text>
        )}
      </Card>

      <Card>
        <SecretField label="UPI ID" value={data.upi_id} />
        <SecretField label="Linked bank" value={data.linked_bank} />
        <SecretField label="PAN" value={data.pan} monospace />
        <SecretField label="Notes" value={data.notes} />
      </Card>

      <Button title="Edit account" onPress={() => setEditing(true)} />
      <Button
        title="New IPO application from this account"
        variant="secondary"
        onPress={() => router.push(`/applications/new?accountId=${id}`)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.lg, gap: spacing.md },
  title: { ...type.title, color: colors.text },
  subtitle: { ...type.body, color: colors.textMuted, marginTop: 2 },
  meta: { ...type.caption, color: colors.textMuted, marginTop: spacing.md },
});
