/**
 * Low-level crypto primitives for the vault.
 *
 * Deliberately pure functions with no React Native or Supabase imports, so the
 * whole security core is unit-testable under plain Node. Anything that touches
 * device storage lives in secureStore.ts; anything that touches the network
 * lives in lib/db.
 *
 * Choices, and why:
 *  - Argon2id for key derivation: memory-hard, so a stolen ciphertext can't be
 *    brute-forced cheaply on a GPU. Tuned in KDF_PARAMS below.
 *  - XChaCha20-Poly1305 for encryption: authenticated (a tampered ciphertext
 *    fails loudly rather than decrypting to garbage) and takes a 24-byte nonce,
 *    which is large enough that random nonces never realistically collide.
 *  - @noble/*: audited, pure TypeScript, and runs under Hermes. A native
 *    libsodium binding would be faster but would not run in Expo Go.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const SALT_BYTES = 16;

/**
 * Argon2id cost. 64 MiB / 3 passes is the OWASP-recommended floor and takes
 * roughly 1s on a desktop, a few seconds on a mid-range phone. That cost is
 * paid once per unlock, not per read, so we spend it rather than weakening it.
 */
export const KDF_PARAMS: KdfParams = { t: 3, m: 65536, p: 1, dkLen: KEY_BYTES };

export type KdfParams = { t: number; m: number; p: number; dkLen: number };

/**
 * Cheap parameters for unit tests only. Argon2id is memory-hard by design, and
 * Jest's VM sandbox runs it slowly enough that production parameters make the
 * suite take minutes. Our tests exercise *our* logic — round-trips, the
 * verifier, recovery — so they can safely turn the cost down; Argon2's own
 * correctness is @noble/hashes' responsibility, covered by its own test vectors.
 *
 * Never pass these from application code. `kdfParamsAreProductionGrade` guards
 * against that and is asserted in the test suite.
 */
export const TEST_KDF_PARAMS: KdfParams = { t: 1, m: 512, p: 1, dkLen: KEY_BYTES };

/** OWASP floor for Argon2id: at least 19 MiB of memory and 2 passes. */
export function kdfParamsAreProductionGrade(params: KdfParams): boolean {
  return params.m >= 19456 && params.t >= 2 && params.dkLen >= 32;
}

/** Constant string encrypted under the vault key to detect a wrong passphrase. */
export const VERIFIER_PLAINTEXT = 'ipo-tracker:vault:v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return globalThis.btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function generateSalt(): string {
  return toBase64(randomBytes(SALT_BYTES));
}

/**
 * Derive the 32-byte vault key from the master passphrase.
 *
 * The returned key must never be logged, persisted anywhere except the
 * Keystore-backed secure store, or included in a network request.
 */
export async function deriveVaultKey(
  passphrase: string,
  saltB64: string,
  params: KdfParams = KDF_PARAMS,
): Promise<Uint8Array> {
  if (!passphrase) throw new Error('Passphrase is required');
  const salt = fromBase64(saltB64);
  return argon2idAsync(encoder.encode(passphrase.normalize('NFKC')), salt, {
    ...params,
    // Yield to the event loop between passes so the UI thread keeps painting
    // its progress spinner instead of freezing for several seconds.
    asyncTick: 16,
  });
}

/**
 * Encrypt a string. Returns base64(nonce || ciphertext||tag) — the single value
 * that goes into a `*_enc` column.
 *
 * A fresh random nonce per call means encrypting the same password twice
 * produces different ciphertext, so the database never reveals that two
 * accounts share a password.
 */
export function encryptString(key: Uint8Array, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(encoder.encode(plaintext));
  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce, 0);
  packed.set(ciphertext, nonce.length);
  return toBase64(packed);
}

/**
 * Decrypt a `*_enc` value. Throws if the key is wrong or the ciphertext was
 * tampered with — Poly1305 authentication makes those the same failure.
 */
export function decryptString(key: Uint8Array, packedB64: string): string {
  const packed = fromBase64(packedB64);
  if (packed.length <= NONCE_BYTES) throw new Error('Ciphertext is malformed');
  const nonce = packed.subarray(0, NONCE_BYTES);
  const ciphertext = packed.subarray(NONCE_BYTES);
  return decoder.decode(xchacha20poly1305(key, nonce).decrypt(ciphertext));
}

/** Encrypt the known verifier plaintext, for storage in profiles.vault_verifier. */
export function buildVerifier(key: Uint8Array): string {
  return encryptString(key, VERIFIER_PLAINTEXT);
}

/** True when `key` is the key that produced `verifier`. Never throws. */
export function checkVerifier(key: Uint8Array, verifier: string): boolean {
  try {
    return decryptString(key, verifier) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

/** Overwrite key material in place once we're done with it. */
export function wipe(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0);
}

// ---------------------------------------------------------------------------
// Recovery code
// ---------------------------------------------------------------------------

/**
 * Crockford base32 without I, L, O, U — avoids characters that get misread when
 * the code is written down or typed back in.
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A 25-character grouped recovery code, ~125 bits of entropy. This is the only
 * escape hatch if the master passphrase is forgotten, so it is generated from a
 * CSPRNG and shown exactly once.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(25);
  let out = '';
  for (let i = 0; i < 25; i++) {
    if (i > 0 && i % 5 === 0) out += '-';
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return out;
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Wrap the vault key under the recovery code so the key can be restored without
 * the passphrase. Stored in profiles.vault_recovery_blob.
 */
export async function wrapKeyWithRecoveryCode(
  vaultKey: Uint8Array,
  recoveryCode: string,
  saltB64: string,
  params: KdfParams = KDF_PARAMS,
): Promise<string> {
  const wrappingKey = await deriveVaultKey(normaliseRecoveryCode(recoveryCode), saltB64, params);
  try {
    return encryptString(wrappingKey, toBase64(vaultKey));
  } finally {
    wipe(wrappingKey);
  }
}

/** Recover the vault key from the recovery code. Throws on a wrong code. */
export async function unwrapKeyWithRecoveryCode(
  blob: string,
  recoveryCode: string,
  saltB64: string,
  params: KdfParams = KDF_PARAMS,
): Promise<Uint8Array> {
  const wrappingKey = await deriveVaultKey(normaliseRecoveryCode(recoveryCode), saltB64, params);
  try {
    return fromBase64(decryptString(wrappingKey, blob));
  } finally {
    wipe(wrappingKey);
  }
}
