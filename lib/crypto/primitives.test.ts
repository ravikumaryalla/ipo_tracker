/**
 * Tests for the vault crypto core. These are the tests that matter most in this
 * codebase: if they pass, a database breach exposes nothing.
 *
 * Every derivation here passes TEST_KDF_PARAMS. Argon2id at production cost is
 * memory-hard on purpose and Jest's VM sandbox runs it slowly enough to make the
 * suite unusable. What we verify is our own logic; Argon2's correctness is
 * covered by @noble/hashes' own test vectors. The one thing we do assert about
 * production cost is that it stays above the OWASP floor.
 */
import {
  buildVerifier,
  checkVerifier,
  decryptString,
  deriveVaultKey,
  encryptString,
  fromBase64,
  generateRecoveryCode,
  generateSalt,
  KDF_PARAMS,
  kdfParamsAreProductionGrade,
  NONCE_BYTES,
  normaliseRecoveryCode,
  TEST_KDF_PARAMS,
  toBase64,
  unwrapKeyWithRecoveryCode,
  VERIFIER_PLAINTEXT,
  wipe,
  wrapKeyWithRecoveryCode,
} from './primitives';

const PASSPHRASE = 'correct horse battery staple';
const P = TEST_KDF_PARAMS;

describe('KDF parameters', () => {
  it('ships production parameters that meet the OWASP floor', () => {
    expect(kdfParamsAreProductionGrade(KDF_PARAMS)).toBe(true);
    expect(KDF_PARAMS.m).toBeGreaterThanOrEqual(19456);
    expect(KDF_PARAMS.t).toBeGreaterThanOrEqual(2);
  });

  it('flags the test parameters as unfit for production', () => {
    expect(kdfParamsAreProductionGrade(TEST_KDF_PARAMS)).toBe(false);
  });
});

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('deriveVaultKey', () => {
  it('is deterministic for the same passphrase and salt', async () => {
    const salt = generateSalt();
    const a = await deriveVaultKey(PASSPHRASE, salt, P);
    const b = await deriveVaultKey(PASSPHRASE, salt, P);
    expect(toBase64(a)).toBe(toBase64(b));
    expect(a).toHaveLength(32);
  });

  it('produces a different key for a different salt', async () => {
    const a = await deriveVaultKey(PASSPHRASE, generateSalt(), P);
    const b = await deriveVaultKey(PASSPHRASE, generateSalt(), P);
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it('produces a different key for a different passphrase', async () => {
    const salt = generateSalt();
    const a = await deriveVaultKey(PASSPHRASE, salt, P);
    const b = await deriveVaultKey(PASSPHRASE + '!', salt, P);
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it('rejects an empty passphrase', async () => {
    await expect(deriveVaultKey('', generateSalt(), P)).rejects.toThrow(/required/i);
  });

  it('matches a known Argon2id answer (guards against a backend swap changing keys)', async () => {
    // Derived once with @noble/hashes argon2id at these parameters. If the KDF
    // backend in argon2.ts ever produces something else for the same inputs,
    // every existing vault would stop unlocking — this test is the tripwire.
    const salt = toBase64(new TextEncoder().encode('0123456789abcdef'));
    const key = await deriveVaultKey(PASSPHRASE, salt, P);
    expect(toBase64(key)).toBe('wzPEFVvhVXy4Rdln99+vLMlE/TkQy0pvGpQgG5yQWfk=');
  });

  it('normalises unicode so the same typed passphrase always works', async () => {
    const salt = generateSalt();
    // Same text, composed (U+00F6) vs decomposed (o + U+0308).
    const composed = await deriveVaultKey('wörd', salt, P);
    const decomposed = await deriveVaultKey('wörd', salt, P);
    expect(toBase64(composed)).toBe(toBase64(decomposed));
  });
});

describe('encryptString / decryptString', () => {
  let key: Uint8Array;

  beforeAll(async () => {
    key = await deriveVaultKey(PASSPHRASE, generateSalt(), P);
  });

  it('round-trips a password', () => {
    const secret = 'Zerodha#2026$ecret';
    expect(decryptString(key, encryptString(key, secret))).toBe(secret);
  });

  it('round-trips unicode, empty and long strings', () => {
    for (const value of ['', 'हिन्दी', '🔐🔑', 'a'.repeat(5000)]) {
      expect(decryptString(key, encryptString(key, value))).toBe(value);
    }
  });

  it('produces different ciphertext each time (nonce uniqueness)', () => {
    const a = encryptString(key, 'same-password');
    const b = encryptString(key, 'same-password');
    expect(a).not.toBe(b);
    expect(decryptString(key, a)).toBe('same-password');
    expect(decryptString(key, b)).toBe('same-password');
  });

  it('never leaks the plaintext into the ciphertext', () => {
    const secret = 'PlainTextNeedle';
    expect(globalThis.atob(encryptString(key, secret))).not.toContain(secret);
  });

  it('fails with the wrong key rather than returning garbage', async () => {
    const wrongKey = await deriveVaultKey('not the passphrase', generateSalt(), P);
    const packed = encryptString(key, 'secret');
    expect(() => decryptString(wrongKey, packed)).toThrow();
  });

  it('detects tampering', () => {
    const packed = fromBase64(encryptString(key, 'secret'));
    packed[packed.length - 1] ^= 0xff; // flip a bit in the auth tag
    expect(() => decryptString(key, toBase64(packed))).toThrow();
  });

  it('rejects a truncated payload', () => {
    expect(() => decryptString(key, toBase64(new Uint8Array(NONCE_BYTES)))).toThrow(/malformed/i);
  });
});

describe('verifier', () => {
  it('accepts the right key and rejects the wrong one', async () => {
    const salt = generateSalt();
    const key = await deriveVaultKey(PASSPHRASE, salt, P);
    const verifier = buildVerifier(key);

    expect(checkVerifier(key, verifier)).toBe(true);
    expect(decryptString(key, verifier)).toBe(VERIFIER_PLAINTEXT);

    const wrongKey = await deriveVaultKey('wrong passphrase', salt, P);
    expect(checkVerifier(wrongKey, verifier)).toBe(false);
  });

  it('returns false instead of throwing on a malformed verifier', async () => {
    const key = await deriveVaultKey(PASSPHRASE, generateSalt(), P);
    expect(checkVerifier(key, 'not-base64-at-all!!')).toBe(false);
    expect(checkVerifier(key, '')).toBe(false);
  });
});

describe('recovery code', () => {
  it('generates a grouped code with no ambiguous characters', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('generates a different code every time', () => {
    const codes = new Set(Array.from({ length: 50 }, generateRecoveryCode));
    expect(codes.size).toBe(50);
  });

  it('normalises user-typed formatting', () => {
    expect(normaliseRecoveryCode('abc de-fgh ij')).toBe('ABCDEFGHIJ');
  });

  it('restores the vault key from the recovery code', async () => {
    const salt = generateSalt();
    const key = await deriveVaultKey(PASSPHRASE, salt, P);
    const code = generateRecoveryCode();
    const blob = await wrapKeyWithRecoveryCode(key, code, salt, P);

    // Typed back in lowercase with sloppy spacing — still works.
    const sloppy = code.toLowerCase().replace(/-/g, ' ');
    const restored = await unwrapKeyWithRecoveryCode(blob, sloppy, salt, P);
    expect(toBase64(restored)).toBe(toBase64(key));

    // And the restored key really does open existing data.
    expect(decryptString(restored, encryptString(key, 'my-password'))).toBe('my-password');
  });

  it('rejects a wrong recovery code', async () => {
    const salt = generateSalt();
    const key = await deriveVaultKey(PASSPHRASE, salt, P);
    const blob = await wrapKeyWithRecoveryCode(key, generateRecoveryCode(), salt, P);
    await expect(
      unwrapKeyWithRecoveryCode(blob, generateRecoveryCode(), salt, P),
    ).rejects.toThrow();
  });
});

describe('wipe', () => {
  it('zeroes key material in place', () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    wipe(key);
    expect(Array.from(key)).toEqual([0, 0, 0, 0]);
    expect(() => wipe(null)).not.toThrow();
  });
});
