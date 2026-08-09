/**
 * Demat account data access.
 *
 * This module is the ONLY place that converts between plaintext credentials and
 * the `*_enc` columns. Screens deal exclusively in `DematAccount` (plaintext,
 * in memory) and never see a ciphertext string. Keeping the boundary here is
 * what makes it structurally hard for a screen to persist a plaintext password
 * by accident.
 */
import { decryptString, encryptString } from '../crypto/primitives';
import { supabase } from '../supabase';
import type { DematAccountRow } from '../types';
import { dbError } from './error';

/** Fields that are encrypted at rest. Order matters only for readability. */
export const SECRET_FIELDS = [
  'client_id',
  'dp_id',
  'bo_id',
  'username',
  'password',
  'txn_password',
  'upi_id',
  'linked_bank',
  'pan',
  'notes',
] as const;

export type SecretField = (typeof SECRET_FIELDS)[number];

/** A decrypted account, as screens see it. Never persisted in this shape. */
export type DematAccount = {
  id: string;
  broker_id: string | null;
  nickname: string;
  is_active: boolean;
  opened_on: string | null;
  password_changed_at: string | null;
  updated_at: string;
} & Record<SecretField, string>;

export type DematAccountInput = {
  broker_id: string | null;
  nickname: string;
  is_active?: boolean;
  opened_on?: string | null;
} & Partial<Record<SecretField, string>>;

/**
 * A row as the list screen sees it before unlocking: labels only, no secrets.
 * Lets the account list render while the vault is still locked.
 */
export type DematAccountSummary = {
  id: string;
  broker_id: string | null;
  nickname: string;
  is_active: boolean;
  password_changed_at: string | null;
  updated_at: string;
};

const encColumn = (field: SecretField) => `${field}_enc` as keyof DematAccountRow;

/**
 * Decrypt one field, tolerating failure. A single corrupt column should surface
 * as one unreadable field, not a crash that hides the other nine.
 */
function decryptField(key: Uint8Array, packed: string | null): string {
  if (!packed) return '';
  try {
    return decryptString(key, packed);
  } catch {
    return '⚠ could not decrypt';
  }
}

export function decryptAccount(key: Uint8Array, row: DematAccountRow): DematAccount {
  const secrets = {} as Record<SecretField, string>;
  for (const field of SECRET_FIELDS) {
    secrets[field] = decryptField(key, row[encColumn(field)] as string | null);
  }
  return {
    id: row.id,
    broker_id: row.broker_id,
    nickname: row.nickname,
    is_active: row.is_active,
    opened_on: row.opened_on,
    password_changed_at: row.password_changed_at,
    updated_at: row.updated_at,
    ...secrets,
  };
}

/**
 * Build the encrypted column patch for an input. Empty strings are stored as
 * NULL rather than as ciphertext of '', so "not set" is distinguishable from
 * "set to blank".
 */
export function encryptInput(key: Uint8Array, input: DematAccountInput): Partial<DematAccountRow> {
  const patch: Partial<DematAccountRow> = {};
  for (const field of SECRET_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    (patch as Record<string, string | null>)[`${field}_enc`] =
      value === '' ? null : encryptString(key, value);
  }
  return patch;
}

/** Labels only — safe to call while the vault is locked. */
export async function listAccountSummaries(): Promise<DematAccountSummary[]> {
  const { data, error } = await supabase
    .from('demat_accounts')
    .select('id, broker_id, nickname, is_active, password_changed_at, updated_at')
    .order('nickname');
  if (error) throw dbError(error);
  return data as DematAccountSummary[];
}

export async function getAccount(key: Uint8Array, id: string): Promise<DematAccount> {
  const { data, error } = await supabase.from('demat_accounts').select('*').eq('id', id).single();
  if (error) throw dbError(error);
  return decryptAccount(key, data);
}

export async function createAccount(
  key: Uint8Array,
  userId: string,
  input: DematAccountInput,
): Promise<DematAccount> {
  const { data, error } = await supabase
    .from('demat_accounts')
    .insert({
      user_id: userId,
      broker_id: input.broker_id,
      nickname: input.nickname,
      is_active: input.is_active ?? true,
      opened_on: input.opened_on ?? null,
      password_changed_at: input.password ? new Date().toISOString() : null,
      ...encryptInput(key, input),
    })
    .select()
    .single();
  if (error) throw dbError(error);
  return decryptAccount(key, data);
}

/**
 * Update an account, archiving any secret that changes.
 *
 * The prior ciphertext goes to credential_history first. If that insert fails
 * we abort rather than overwrite, so a typo can always be walked back — Postgres
 * has no transaction across two PostgREST calls, so ordering is the safeguard.
 */
export async function updateAccount(
  key: Uint8Array,
  userId: string,
  id: string,
  input: DematAccountInput,
): Promise<DematAccount> {
  const { data: existing, error: readError } = await supabase
    .from('demat_accounts')
    .select('*')
    .eq('id', id)
    .single();
  if (readError) throw readError;

  const history: {
    user_id: string;
    demat_account_id: string;
    field: string;
    old_value_enc: string;
  }[] = [];

  for (const field of SECRET_FIELDS) {
    const next = input[field];
    if (next === undefined) continue;
    const previousPacked = existing[encColumn(field)] as string | null;
    if (!previousPacked) continue;
    if (decryptField(key, previousPacked) === next) continue;
    history.push({
      user_id: userId,
      demat_account_id: id,
      field,
      old_value_enc: previousPacked,
    });
  }

  if (history.length > 0) {
    const { error: historyError } = await supabase.from('credential_history').insert(history);
    if (historyError) throw historyError;
  }

  const passwordChanged = history.some((h) => h.field === 'password');

  const { data, error } = await supabase
    .from('demat_accounts')
    .update({
      broker_id: input.broker_id,
      nickname: input.nickname,
      ...(input.is_active === undefined ? {} : { is_active: input.is_active }),
      ...(input.opened_on === undefined ? {} : { opened_on: input.opened_on }),
      ...(passwordChanged ? { password_changed_at: new Date().toISOString() } : {}),
      ...encryptInput(key, input),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw dbError(error);
  return decryptAccount(key, data);
}

export async function deleteAccount(id: string): Promise<void> {
  const { error } = await supabase.from('demat_accounts').delete().eq('id', id);
  if (error) throw dbError(error);
}

/**
 * Re-encrypt every account under a new key. Used by the change-passphrase flow.
 *
 * Rows are rewritten one at a time; a partial failure leaves earlier rows on the
 * new key and later rows on the old one, so the caller must only swap the
 * profile's salt/verifier after this resolves.
 */
export async function reencryptAllAccounts(
  oldKey: Uint8Array,
  newKey: Uint8Array,
): Promise<number> {
  const { data, error } = await supabase.from('demat_accounts').select('*');
  if (error) throw dbError(error);

  let rewritten = 0;
  for (const row of data as DematAccountRow[]) {
    const patch: Partial<DematAccountRow> = {};
    for (const field of SECRET_FIELDS) {
      const packed = row[encColumn(field)] as string | null;
      (patch as Record<string, string | null>)[`${field}_enc`] = packed
        ? encryptString(newKey, decryptString(oldKey, packed))
        : null;
    }
    const { error: writeError } = await supabase
      .from('demat_accounts')
      .update(patch)
      .eq('id', row.id);
    if (writeError) throw writeError;
    rewritten += 1;
  }
  return rewritten;
}
