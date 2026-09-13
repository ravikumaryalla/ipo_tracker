/**
 * Expo push tokens, one row per device — see
 * supabase/migrations/20260811000010_push_tokens.sql and
 * ...20260828000001_push_tokens_lifecycle.sql. Thin CRUD, same shape as the
 * rest of lib/db.
 */
import { supabase } from '../supabase';
import { dbError } from './error';

type PushTokenMeta = { platform?: string | null };

export async function upsertPushToken(
  userId: string,
  token: string,
  meta: PushTokenMeta = {},
): Promise<void> {
  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      token,
      platform: meta.platform ?? null,
      // Bumped on every (re)registration so a stale value flags a device that
      // has not opened the app in a while. On a fresh insert this equals the
      // column default; spelling it out keeps the conflict path honest.
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,token' },
  );
  if (error) {
    // Every caller swallows this (silent registration, the rotation listener,
    // sign-out), which is deliberate — a token write must never break the flow
    // it hangs off. But a swallowed error here means no device ever registers
    // and no allotment push is ever sent, so make it visible while developing.
    const wrapped = dbError(error);
    if (__DEV__) console.warn('[pushTokens] upsert failed:', wrapped.message);
    throw wrapped;
  }
}

export async function deletePushToken(token: string): Promise<void> {
  const { error } = await supabase.from('push_tokens').delete().eq('token', token);
  if (error) throw dbError(error);
}

export async function hasPushToken(token: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('push_tokens')
    .select('id')
    .eq('token', token)
    .maybeSingle();
  if (error) throw dbError(error);
  return data !== null;
}
