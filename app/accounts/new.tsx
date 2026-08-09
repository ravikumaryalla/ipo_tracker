import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';

import { AccountForm } from '../../components/AccountForm';
import { Loading, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { createAccount } from '../../lib/db/accounts';
import { listBrokers } from '../../lib/db/brokers';
import { requireKey, useVault } from '../../lib/vault';

export default function NewAccount() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userId } = useAuth();
  const { getKey } = useVault();

  const brokers = useQuery({ queryKey: ['brokers'], queryFn: listBrokers });

  if (brokers.isLoading) return <Loading />;

  return (
    <Screen>
      <AccountForm
        brokers={brokers.data ?? []}
        submitLabel="Save account"
        onSubmit={async (input) => {
          if (!userId) throw new Error('Not signed in.');
          await createAccount(requireKey(getKey), userId, input);
          await queryClient.invalidateQueries({ queryKey: ['accounts'] });
          router.back();
        }}
      />
    </Screen>
  );
}
