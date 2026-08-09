/**
 * Supabase client.
 *
 * The anon key shipped in the app is public by design: every table is guarded
 * by Row Level Security, and every credential is already ciphertext before it
 * reaches the network. The service_role key must never appear in this bundle.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

import type { Database } from './types';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env and fill in your Supabase project details.',
  );
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    // Sessions live in AsyncStorage, not SecureStore: they are short-lived
    // bearer tokens, and SecureStore's biometric gating would prompt on every
    // token refresh. The vault key is the thing that gets Keystore protection.
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // React Native has no URL bar to parse a session out of.
    detectSessionInUrl: false,
  },
});
