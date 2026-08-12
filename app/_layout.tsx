/**
 * Root layout and the routing gate.
 *
 * There are three doors in sequence: signed in? → vault set up? → vault
 * unlocked? Each redirect below corresponds to one of them. Keeping the whole
 * decision in one effect makes the access rules readable in one place.
 */
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { Sora_600SemiBold, Sora_700Bold } from '@expo-google-fonts/sora';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, defaultShouldDehydrateQuery } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-get-random-values';

import { Button, Loading } from '../components/ui';
import { colors, fonts, spacing, type } from '../constants/theme';
import { AuthProvider, useAuth } from '../lib/auth';
import { VaultProvider, useVault } from '../lib/vault';

// Hold the native splash until the fonts are ready. Without this the first
// frame renders in the system font and visibly reflows once Sora/Inter land.
SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      gcTime: 7 * 24 * 60 * 60 * 1000,
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'ipo_tracker.query_cache',
});

/**
 * Any query key containing 'decrypted' holds plaintext credentials in memory.
 *
 * AsyncStorage is NOT encrypted — persisting those queries would write the very
 * passwords we encrypt for the database into a plain file on disk, defeating
 * the whole design. Everything else (IPOs, applications, account labels) is
 * non-secret and is safe to cache offline.
 */
const PLAINTEXT_QUERY_MARKER = 'decrypted';

function isPersistable(queryKey: readonly unknown[]): boolean {
  return !queryKey.some((part) => part === PLAINTEXT_QUERY_MARKER);
}

function RouteGate({ children }: { children: React.ReactNode }) {
  const { session, loading: authLoading } = useAuth();
  const { status, refresh } = useVault();
  const [retrying, setRetrying] = useState(false);
  // Typed loosely: expo-router narrows this to the known route tuples, but we
  // only care about the first two path segments.
  const segments = useSegments() as string[];
  const router = useRouter();

  // Locking must actually make the plaintext unavailable. Without this the
  // decrypted rows would sit in the query cache and repopulate the UI the
  // moment a screen re-rendered, whatever the lock screen said.
  useEffect(() => {
    if (status === 'locked' || status === 'loading' || status === 'error') {
      queryClient.removeQueries({
        predicate: (query) => !isPersistable(query.queryKey),
      });
    }
  }, [status]);

  useEffect(() => {
    if (authLoading) return;

    const group = segments[0];
    const inAuth = group === '(auth)';
    const inVault = group === 'vault';

    if (!session) {
      if (!inAuth) router.replace('/(auth)/sign-in');
      return;
    }

    // Signed in. Wait for the profile read before deciding about the vault,
    // otherwise we'd bounce the user to setup on every cold start. 'error'
    // renders its own retry screen below instead of navigating anywhere.
    if (status === 'loading' || status === 'error') return;

    if (status === 'uninitialised') {
      if (segments[1] !== 'setup') router.replace('/vault/setup');
      return;
    }

    if (status === 'locked') {
      if (segments[1] !== 'unlock') router.replace('/vault/unlock');
      return;
    }

    // Unlocked — nothing to do unless we're still parked on a gate screen.
    if (inAuth || inVault) router.replace('/(tabs)');
  }, [authLoading, session, status, segments, router]);

  if (authLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
        <Loading />
      </View>
    );
  }

  // The profile read failed — without this screen the gate above would wait on
  // a status that never changes and the user would be parked on a blank screen.
  if (session && status === 'error') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          justifyContent: 'center',
          paddingHorizontal: spacing.xl,
        }}
      >
        <Text style={{ ...type.body, color: colors.text, textAlign: 'center', marginBottom: spacing.lg }}>
          Couldn&apos;t load your account. Check your connection and try again.
        </Text>
        <Button
          title="Retry"
          loading={retrying}
          onPress={async () => {
            setRetrying(true);
            try {
              await refresh();
            } catch {
              // Still failing — stay on this screen; the user can retry again.
            } finally {
              setRetrying(false);
            }
          }}
        />
      </View>
    );
  }

  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Sora_600SemiBold,
    Sora_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  const onReady = useCallback(() => {
    // Also fires on fontError: a missing font is not worth trapping someone
    // behind a splash screen forever — the app degrades to the system face.
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => undefined);
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider onLayout={onReady}>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        dehydrateOptions: {
          // Both conditions matter. The key check keeps plaintext off disk; the
          // default check keeps in-flight and failed queries off disk. Dropping
          // the latter would persist a pending query's promise, which React
          // Query then rehydrates and warns about the moment it rejects.
          shouldDehydrateQuery: (query) =>
            isPersistable(query.queryKey) && defaultShouldDehydrateQuery(query),
        },
      }}
    >
      <AuthProvider>
        <VaultProvider>
          <StatusBar style="light" />
          <RouteGate>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerTintColor: colors.text,
                headerTitleStyle: { fontFamily: fonts.displayMedium, fontSize: 17 },
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="vault" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="accounts/[id]" options={{ title: 'Account' }} />
              <Stack.Screen name="accounts/new" options={{ title: 'Add account' }} />
              <Stack.Screen name="ipos/[id]" options={{ title: 'IPO' }} />
              <Stack.Screen name="ipos/new" options={{ title: 'Add IPO' }} />
              <Stack.Screen name="applications/new" options={{ title: 'New application' }} />
              <Stack.Screen name="applications/[id]" options={{ title: 'Application' }} />
              <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
              <Stack.Screen
                name="settings/change-pin"
                options={{ title: 'Change PIN' }}
              />
            </Stack>
          </RouteGate>
        </VaultProvider>
      </AuthProvider>
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}
