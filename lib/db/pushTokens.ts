/**
 * Expo push tokens, one row per device — see
 * supabase/migrations/20260811000010_push_tokens.sql. Thin CRUD, same shape
 * as the rest of lib/db.
 */
import { supabase } from '../supabase';
import { dbError } from './error';

export async function upsertPushToken(userId: string, token: string): Promise<void> {
  const { error } = await supabase
    .from('push_tokens')
    .upsert({ user_id: userId, token }, { onConflict: 'user_id,token' });
  if (error) throw dbError(error);
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
