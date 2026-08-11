/**
 * Argon2id key derivation backend.
 *
 * Two implementations behind one function:
 *
 *  - Native (react-native-libsodium): runs libsodium's C implementation via
 *    JSI. Blocks the JS thread for a few hundred milliseconds instead of the
 *    tens of seconds the pure-JS version takes, which is what made the unlock
 *    screen appear frozen. Requires a development/production build.
 *
 *  - Pure JS (@noble/hashes): used wherever the native module cannot load —
 *    Node/Jest and Expo Go. noble's own `argon2idAsync` yields with
 *    `async () => {}`, a microtask-only yield that never returns control to
 *    React Native's event loop, so we replace its `nextTick` with a real
 *    setTimeout-based macrotask yield before use. Slow, but the UI keeps
 *    painting.
 *
 * Both produce identical output for identical inputs (Argon2id v1.3), so a
 * vault created on one path unlocks on the other.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import * as nobleUtils from '@noble/hashes/utils.js';

import type { KdfParams } from './primitives';

type Libsodium = {
  ready: Promise<void>;
  loadSumoVersion?: () => void;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_pwhash_SALTBYTES: number;
  crypto_pwhash: (
    keyLength: number,
    password: Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
  ) => Uint8Array;
};

let sodium: Libsodium | null | undefined;

function loadSodium(): Libsodium | null {
  if (sodium !== undefined) return sodium;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sodium = require('react-native-libsodium') as Libsodium;
    // On web, crypto_pwhash only exists in libsodium's sumo build; this must
    // be called before awaiting `ready`. A no-op elsewhere.
    sodium.loadSumoVersion?.();
  } catch {
    // No native module in this runtime (Node/Jest/Expo Go) — use the JS path.
    sodium = null;
  }
  return sodium;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function deriveNative(
  sodiumMod: Libsodium,
  passwordBytes: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array | null> {
  await sodiumMod.ready;

  // libsodium's Argon2id is fixed at one lane and takes exactly a
  // SALTBYTES-long salt; anything else must go through noble instead of
  // silently deriving a different key.
  if (params.p !== 1 || salt.length !== sodiumMod.crypto_pwhash_SALTBYTES || params.dkLen < 16) {
    return null;
  }

  // Let one frame paint (the caller's busy spinner) before the synchronous
  // native call blocks the JS thread.
  await macrotask();

  const key = sodiumMod.crypto_pwhash(
    params.dkLen,
    passwordBytes,
    salt,
    params.t,
    params.m * 1024, // libsodium takes bytes; KdfParams.m is KiB
    sodiumMod.crypto_pwhash_ALG_ARGON2ID13,
  );
  return key instanceof Uint8Array ? key : new Uint8Array(key);
}

function deriveJs(
  passwordBytes: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array> {
  try {
    // Under Metro/Babel the namespace is the mutable CJS exports object and
    // argon2.js reads `nextTick` off it at call time, so this takes effect.
    // Under real Node ESM the namespace is frozen and this throws — fine,
    // there is no UI thread to starve there.
    (nobleUtils as { nextTick: () => Promise<void> }).nextTick = macrotask;
  } catch {
    // Keep going with noble's microtask yield.
  }
  // asyncTick: run at most ~16ms of derivation between (now genuine) yields.
  return argon2idAsync(passwordBytes, salt, { ...params, asyncTick: 16 });
}

/** Derive `params.dkLen` raw bytes with Argon2id. */
export async function argon2idRaw(
  passwordBytes: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array> {
  const sodiumMod = loadSodium();
  if (sodiumMod) {
    try {
      const key = await deriveNative(sodiumMod, passwordBytes, salt, params);
      if (key) return key;
    } catch {
      // Both backends derive the same key for the same inputs, so falling
      // back on a native failure can never unlock with a wrong key — only
      // slowly with the right one.
    }
  }
  return deriveJs(passwordBytes, salt, params);
}
