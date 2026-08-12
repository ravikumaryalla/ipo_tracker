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

/**
 * Fields that are encrypted at rest. Order matters only for readability.
 *
 * `pan` is deliberately NOT in this list — see 20260811000007_pan_plaintext.sql
 * for why it's a plain column now, unlike every other field here.
 */
export const SECRET_FIELDS = [
  'client_id',
  'dp_id',
  'bo_id',
  'email',
  'phone',
  'password',
  'mpin',
  'upi_id',
  'linked_bank',
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
  /** Plain, not decrypted — see SECRET_FIELDS. */
  pan: string;
} & Record<SecretField, string>;

export type DematAccountInput = {
  broker_id: string | null;
  nickname: string;
  is_active?: boolean;
  opened_on?: string | null;
  pan: string;
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
    pan: row.pan ?? '',
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
      pan: input.pan || null,
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

  // pan is a plain column, not one of SECRET_FIELDS, so it's handled here
  // instead of the loop above — but credential_history.old_value_enc is
  // NOT NULL and shared across every field, so the audit trail still gets
  // an encrypted value: the previous plain PAN, re-encrypted on the way in.
  if (input.pan !== undefined && (existing.pan ?? '') !== '' && existing.pan !== input.pan) {
    history.push({
      user_id: userId,
      demat_account_id: id,
      field: 'pan',
      old_value_enc: encryptString(key, existing.pan as string),
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
      pan: input.pan || null,
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
 * Re-encrypt every account under a new key. Used by the change-PIN flow.
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
    // pan_enc is legacy (see migratePanIfNeeded below) but a row that hasn't
    // been migrated yet this session still needs it rotated too, or it would
    // be left permanently undecryptable under the old key.
    if (row.pan_enc) {
      patch.pan_enc = encryptString(newKey, decryptString(oldKey, row.pan_enc));
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

/**
 * One-time, per-account migration off encrypted PAN: decrypts pan_enc with
 * the just-unlocked key, writes the plain pan column, and clears pan_enc.
 * Idempotent by construction — a row only matches the query once, since
 * clearing pan_enc is what stops it matching again next time this runs.
 *
 * Call sites tolerate this failing outright (network hiccup, etc.) since it's
 * a background cleanup, not something unlock should ever block on. A single
 * row's decrypt failure (e.g. pan_enc corrupted, or already rotated under a
 * different key by a passphrase change that raced this) is skipped rather
 * than aborting the rest of the batch.
 */
export async function migratePanIfNeeded(key: Uint8Array): Promise<number> {
  const { data, error } = await supabase
    .from('demat_accounts')
    .select('id, pan_enc')
    .is('pan', null)
    .not('pan_enc', 'is', null);
  if (error) throw dbError(error);
  if (!data || data.length === 0) return 0;

  let migrated = 0;
  for (const row of data as Pick<DematAccountRow, 'id' | 'pan_enc'>[]) {
    let pan: string;
    try {
      pan = decryptString(key, row.pan_enc as string);
    } catch {
      continue;
    }
    const { error: writeError } = await supabase
      .from('demat_accounts')
      .update({ pan, pan_enc: null })
      .eq('id', row.id);
    if (writeError) continue;
    migrated += 1;
  }
  return migrated;
}
