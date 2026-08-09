import { supabase } from '../supabase';
import type { Broker } from '../types';
import { dbError } from './error';

/** Shared reference data — no encryption, readable by any signed-in user. */
export async function listBrokers(): Promise<Broker[]> {
  const { data, error } = await supabase.from('brokers').select('*').order('name');
  if (error) throw dbError(error);
  return data;
}
