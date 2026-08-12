/**
 * Supabase auth session, exposed to the app.
 *
 * Token refresh is handled by supabase-js itself (autoRefreshToken); this
 * provider only mirrors the resulting session into React state and drives the
 * signed-in/signed-out routing gate.
 */
import type { Session } from '@supabase/supabase-js';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { clearCachedVaultKey } from './crypto/secureStore';
import { disablePushNotifications } from './notifications';
import { supabase } from './supabase';

type AuthContextValue = {
  session: Session | null;
  userId: string | null;
  /** True until the persisted session has been read from storage. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<{ needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // supabase-js only auto-refreshes while the app is foregrounded; without this
  // the session can arrive stale after a long background stretch.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') supabase.auth.startAutoRefresh();
      else supabase.auth.stopAutoRefresh();
    });
    supabase.auth.startAutoRefresh();
    return () => {
      sub.remove();
      supabase.auth.stopAutoRefresh();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      userId: session?.user.id ?? null,
      loading,

      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
        if (error) throw new Error(friendlyAuthError(error.message));
      },

      async signUp(email, password, displayName) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: { data: { display_name: displayName.trim() } },
        });
        if (error) throw new Error(friendlyAuthError(error.message));
        // Supabase returns a user with no session when confirmations are on.
        return { needsEmailConfirmation: !data.session };
      },

      async signOut() {
        // Wipe the cached vault key and this device's push-token row before
        // dropping the session — both must happen while the session (and
        // therefore RLS's auth.uid()) is still valid, and a crash mid-sign-out
        // must never leave either behind for the next account on this device.
        await clearCachedVaultKey();
        await disablePushNotifications().catch(() => undefined);
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
      },

      async sendPasswordReset(email) {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
          redirectTo: 'ipotracker://reset-password',
        });
        if (error) throw new Error(friendlyAuthError(error.message));
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Supabase's raw messages are terse; make the common ones actionable. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'That email and password do not match.';
  if (m.includes('email not confirmed')) return 'Check your inbox and confirm your email first.';
  if (m.includes('user already registered')) return 'An account with that email already exists.';
  if (m.includes('password should be')) return 'Password must be at least 6 characters.';
  // The email limit is per hour, not per minute — telling someone to wait a
  // minute here just makes them retry into the same wall.
  if (m.includes('email rate limit') || m.includes('over_email_send_rate_limit'))
    return 'Too many confirmation emails sent. Please try again in an hour.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts — wait a minute and try again.';
  return message;
}
