/**
 * Live-updates the Allotment Status list while the app is open.
 *
 * A push covers the app being closed; this covers the rest: an outcome checked
 * or recorded on another device while this one is foregrounded. Nothing on the
 * server resolves rows any more — the cron only watches for a result being
 * published and notifies — so another device is now the only source of a change
 * this device did not make itself. Subscribes to the signed-in user's own
 * ipo_applications rows and invalidates the ['applications'] query (which reads
 * the v_application_pnl view — Realtime cannot watch a view, so we watch the
 * base table) on any change.
 *
 * Mounted once in RouteGate. No-op until userId is non-null. Drops the
 * subscription while backgrounded and re-subscribes (plus a catch-up refetch)
 * on return, since the Realtime socket is unreliable in the background on RN.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { supabase } from './supabase';

export function useApplicationsRealtime(userId: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!userId) return;

    let channel: RealtimeChannel | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const invalidateSoon = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['applications'] });
      }, 500);
    };

    const subscribe = () => {
      if (channel) return;
      channel = supabase
        .channel(`applications-${userId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'ipo_applications',
            filter: `user_id=eq.${userId}`,
          },
          invalidateSoon,
        )
        .subscribe();
    };

    const unsubscribe = () => {
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
    };

    subscribe();

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        invalidateSoon();
        subscribe();
      } else {
        unsubscribe();
      }
    });

    return () => {
      if (debounce) clearTimeout(debounce);
      appStateSub.remove();
      unsubscribe();
    };
  }, [userId, queryClient]);
}
