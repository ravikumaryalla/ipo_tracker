/**
 * Tests for the encryption boundary in lib/db/accounts.ts.
 *
 * The claim under test is the one the whole design rests on: what leaves this
 * module towards Postgres contains no plaintext, and what comes back decrypts
 * to exactly what went in.
 */
import { deriveVaultKey, generateSalt, TEST_KDF_PARAMS } from '../crypto/primitives';
import {
  decryptAccount,
  encryptInput,
  SECRET_FIELDS,
  type DematAccountInput,
} from './accounts';
import type { DematAccountRow } from '../types';

let key: Uint8Array;

beforeAll(async () => {
  key = await deriveVaultKey('a test passphrase', generateSalt(), TEST_KDF_PARAMS);
});

const INPUT: DematAccountInput = {
  broker_id: null,
  nickname: 'Zerodha main',
  client_id: 'ZY1234',
  dp_id: 'IN300394',
  bo_id: '1208160012345678',
  email: 'ravi.k@example.com',
  phone: '9876543210',
  password: 'Sup3r$ecret!',
  mpin: '4821',
  upi_id: 'ravi@okhdfcbank',
  linked_bank: 'HDFC ••1234',
  pan: 'ABCDE1234F',
  notes: 'opened 2019, nominee added',
};

/** Build a row the way Postgres would return it, from an encrypted patch. */
function asRow(patch: Partial<DematAccountRow>): DematAccountRow {
  return {
    id: 'row-1',
    user_id: 'user-1',
    broker_id: null,
    nickname: INPUT.nickname,
    client_id_enc: null,
    dp_id_enc: null,
    bo_id_enc: null,
    email_enc: null,
    phone_enc: null,
    password_enc: null,
    mpin_enc: null,
    upi_id_enc: null,
    linked_bank_enc: null,
    pan: null,
    pan_enc: null,
    notes_enc: null,
    is_active: true,
    opened_on: null,
    password_changed_at: null,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    ...patch,
  };
}

/**
 * createAccount/updateAccount send `pan` alongside the encryptInput() patch,
 * not through it — this mirrors that so tests exercise the real shape.
 */
function asRowWithPan(input: DematAccountInput): DematAccountRow {
  return asRow({ ...encryptInput(key, input), pan: input.pan || null });
}

describe('encryptInput', () => {
  it('encrypts every secret field into its _enc column', () => {
    const patch = encryptInput(key, INPUT);
    for (const field of SECRET_FIELDS) {
      expect(patch).toHaveProperty(`${field}_enc`);
      expect(typeof (patch as Record<string, unknown>)[`${field}_enc`]).toBe('string');
    }
  });

  it('emits no plaintext anywhere in the payload sent to Postgres', () => {
    const serialised = JSON.stringify(encryptInput(key, INPUT));
    for (const field of SECRET_FIELDS) {
      const plaintext = INPUT[field];
      if (plaintext) expect(serialised).not.toContain(plaintext);
    }
    // The password in particular, checked explicitly.
    expect(serialised).not.toContain('Sup3r$ecret!');
  });

  it('emits no column that is not an _enc column', () => {
    for (const column of Object.keys(encryptInput(key, INPUT))) {
      expect(column.endsWith('_enc')).toBe(true);
    }
  });

  it('stores an empty value as NULL, distinguishing "unset" from "blank"', () => {
    const patch = encryptInput(key, { ...INPUT, notes: '' });
    expect(patch.notes_enc).toBeNull();
  });

  it('omits fields the caller did not mention, so a partial edit is safe', () => {
    const patch = encryptInput(key, { broker_id: null, nickname: 'x', password: 'new-one', pan: '' });
    expect(patch).toHaveProperty('password_enc');
    expect(patch).not.toHaveProperty('notes_enc');
  });

  it('never touches pan — it is not a secret field, see SECRET_FIELDS', () => {
    const patch = encryptInput(key, INPUT);
    expect(patch).not.toHaveProperty('pan_enc');
    expect(patch).not.toHaveProperty('pan');
  });
});

describe('decryptAccount', () => {
  it('round-trips every encrypted field back to what was entered', () => {
    const account = decryptAccount(key, asRowWithPan(INPUT));
    for (const field of SECRET_FIELDS) {
      expect(account[field]).toBe(INPUT[field]);
    }
    expect(account.nickname).toBe('Zerodha main');
    expect(account.id).toBe('row-1');
  });

  it('passes pan through as plain text, not decrypted', () => {
    const account = decryptAccount(key, asRowWithPan(INPUT));
    expect(account.pan).toBe('ABCDE1234F');
  });

  it('renders a never-set field as an empty string', () => {
    const account = decryptAccount(key, asRow({}));
    expect(account.password).toBe('');
    expect(account.pan).toBe('');
  });

  it('isolates a corrupt field instead of failing the whole account', () => {
    const row = asRowWithPan(INPUT);
    row.password_enc = 'not-valid-ciphertext';

    const account = decryptAccount(key, row);
    expect(account.password).toMatch(/could not decrypt/);
    // The other fields still came through.
    expect(account.email).toBe('ravi.k@example.com');
    expect(account.pan).toBe('ABCDE1234F');
  });

  it('does not decrypt with the wrong key', async () => {
    const otherKey = await deriveVaultKey('different passphrase', generateSalt(), TEST_KDF_PARAMS);
    const account = decryptAccount(otherKey, asRow(encryptInput(key, INPUT)));
    expect(account.password).not.toBe('Sup3r$ecret!');
    expect(account.password).toMatch(/could not decrypt/);
  });
});
