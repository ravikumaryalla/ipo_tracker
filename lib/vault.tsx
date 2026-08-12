/**
 * Vault state: whether the app currently holds the key that can decrypt
 * credentials, and the operations that change that.
 *
 * The key lives in a module-level ref rather than React state on purpose — it
 * must never end up in a component snapshot, a devtools dump, or a serialised
 * navigation state.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  buildVerifier,
  checkVerifier,
  deriveVaultKey,
  generateRecoveryCode,
  generateSalt,
  unwrapKeyWithRecoveryCode,
  wipe,
  wrapKeyWithRecoveryCode,
} from './crypto/primitives';
import {
  cacheVaultKey,
  clearCachedVaultKey,
  isBiometricUnlockEnabled,
  readCachedVaultKey,
} from './crypto/secureStore';
import { dbError } from './db/error';
import { migratePanIfNeeded, reencryptAllAccounts } from './db/accounts';
import { supabase } from './supabase';
import type { Profile } from './types';

export type VaultStatus =
  /** Still reading the profile — we don't yet know if a vault exists. */
  | 'loading'
  /** The profile read failed (usually offline). Retry via refresh(). */
  | 'error'
  /** No PIN has ever been set; the user must create one. */
  | 'uninitialised'
  /** A vault exists but we don't hold the key. */
  | 'locked'
  /** We hold the key; credentials can be read and written. */
  | 'unlocked';

type VaultContextValue = {
  status: VaultStatus;
  autoLockMinutes: number;
  biometricsEnabled: boolean;
  /** Throws with a friendly message if the PIN is wrong. */
  unlock: (passphrase: string) => Promise<void>;
  unlockWithBiometrics: () => Promise<boolean>;
  /** First-run setup. Returns the recovery code, which is shown exactly once. */
  initialise: (passphrase: string) => Promise<string>;
  unlockWithRecoveryCode: (code: string) => Promise<void>;
  /**
   * Re-key the vault. Requires the current PIN (or an unlocked vault
   * reached via recovery code). Returns a fresh recovery code — the old one
   * stops working.
   */
  changePassphrase: (currentPassphrase: string | null, nextPassphrase: string) => Promise<string>;
  enableBiometrics: () => Promise<void>;
  disableBiometrics: () => Promise<void>;
  setAutoLockMinutes: (minutes: number) => Promise<void>;
  lock: () => void;
  /**
   * The live key. Returns null when locked — callers in lib/db treat that as a
   * hard error rather than writing plaintext.
   */
  getKey: () => Uint8Array | null;
  refresh: () => Promise<void>;
};

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const keyRef = useRef<Uint8Array | null>(null);
  const profileRef = useRef<Profile | null>(null);
  const lastActiveRef = useRef<number>(Date.now());

  const [status, setStatus] = useState<VaultStatus>('loading');
  const [autoLockMinutes, setAutoLockMinutesState] = useState(5);
  const [biometricsEnabled, setBiometricsEnabled] = useState(false);

  const lock = useCallback(() => {
    wipe(keyRef.current);
    keyRef.current = null;
    setStatus((prev) =>
      prev === 'uninitialised' || prev === 'loading' || prev === 'error' ? prev : 'locked',
    );
  }, []);

  const loadProfile = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      profileRef.current = null;
      setStatus('loading');
      return;
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', auth.user.id)
      .single();

    if (error) throw dbError(error);

    profileRef.current = data;
    setAutoLockMinutesState(data.auto_lock_minutes);
    setBiometricsEnabled(await isBiometricUnlockEnabled());
    setStatus(data.vault_salt && data.vault_verifier ? 'locked' : 'uninitialised');
  }, []);

  useEffect(() => {
    // 'error' rather than 'loading': a failed read must surface a retry, not
    // leave the gate waiting forever on a status that will never change.
    loadProfile().catch(() => setStatus('error'));

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        lock();
        clearCachedVaultKey().catch(() => undefined);
        profileRef.current = null;
        setStatus('loading');
      } else if (event === 'SIGNED_IN') {
        loadProfile().catch(() => setStatus('error'));
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [loadProfile, lock]);

  // Auto-lock. We compare timestamps on foreground rather than running a timer,
  // because the OS suspends timers for backgrounded apps — a timer would let a
  // long background stretch slip past the lock.
  useEffect(() => {
    if (autoLockMinutes === 0) return; // 0 = never auto-lock

    const onChange = (next: AppStateStatus) => {
      if (next === 'active') {
        const idleMs = Date.now() - lastActiveRef.current;
        if (idleMs > autoLockMinutes * 60_000) lock();
      } else {
        lastActiveRef.current = Date.now();
      }
    };

    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [autoLockMinutes, lock]);

  const persistVaultFields = useCallback(async (patch: Partial<Profile>) => {
    const profile = profileRef.current;
    if (!profile) throw new Error('Not signed in');
    const { data, error } = await supabase
      .from('profiles')
      .update(patch)
      .eq('id', profile.id)
      .select()
      .single();
    if (error) throw dbError(error);
    profileRef.current = data;
    return data;
  }, []);

  const initialise = useCallback<VaultContextValue['initialise']>(
    async (passphrase) => {
      if (!/^\d{6}$/.test(passphrase)) {
        throw new Error('Use a 6-digit PIN.');
      }

      const salt = generateSalt();
      const key = await deriveVaultKey(passphrase, salt);
      const recoveryCode = generateRecoveryCode();
      const recoveryBlob = await wrapKeyWithRecoveryCode(key, recoveryCode, salt);

      await persistVaultFields({
        vault_salt: salt,
        vault_verifier: buildVerifier(key),
        vault_recovery_blob: recoveryBlob,
      });

      keyRef.current = key;
      setStatus('unlocked');
      return recoveryCode;
    },
    [persistVaultFields],
  );

  const unlock = useCallback<VaultContextValue['unlock']>(async (passphrase) => {
    const profile = profileRef.current;
    if (!profile?.vault_salt || !profile.vault_verifier) {
      throw new Error('No vault has been set up on this account yet.');
    }

    const key = await deriveVaultKey(passphrase, profile.vault_salt);
    if (!checkVerifier(key, profile.vault_verifier)) {
      wipe(key);
      throw new Error('That PIN is not correct.');
    }

    keyRef.current = key;
    lastActiveRef.current = Date.now();
    setStatus('unlocked');
    // One-time cleanup, not something unlock should ever wait on or fail for.
    void migratePanIfNeeded(key).catch(() => undefined);
  }, []);

  const unlockWithBiometrics = useCallback(async () => {
    const profile = profileRef.current;
    if (!profile?.vault_verifier) return false;

    // readCachedVaultKey triggers the OS biometric prompt itself.
    const key = await readCachedVaultKey();
    if (!key) return false;

    if (!checkVerifier(key, profile.vault_verifier)) {
      // Stale cache — e.g. the PIN was changed on another device.
      wipe(key);
      await clearCachedVaultKey();
      setBiometricsEnabled(false);
      return false;
    }

    keyRef.current = key;
    lastActiveRef.current = Date.now();
    setStatus('unlocked');
    void migratePanIfNeeded(key).catch(() => undefined);
    return true;
  }, []);

  const unlockWithRecoveryCode = useCallback<VaultContextValue['unlockWithRecoveryCode']>(
    async (code) => {
      const profile = profileRef.current;
      if (!profile?.vault_salt || !profile.vault_recovery_blob || !profile.vault_verifier) {
        throw new Error('No recovery code is registered for this account.');
      }

      let key: Uint8Array;
      try {
        key = await unwrapKeyWithRecoveryCode(
          profile.vault_recovery_blob,
          code,
          profile.vault_salt,
        );
      } catch {
        throw new Error('That recovery code is not correct.');
      }

      if (!checkVerifier(key, profile.vault_verifier)) {
        wipe(key);
        throw new Error('That recovery code is not correct.');
      }

      keyRef.current = key;
      lastActiveRef.current = Date.now();
      setStatus('unlocked');
      void migratePanIfNeeded(key).catch(() => undefined);
    },
    [],
  );

  const changePassphrase = useCallback<VaultContextValue['changePassphrase']>(
    async (currentPassphrase, nextPassphrase) => {
      const profile = profileRef.current;
      if (!profile?.vault_salt || !profile.vault_verifier) {
        throw new Error('No vault has been set up on this account yet.');
      }
      if (!/^\d{6}$/.test(nextPassphrase)) {
        throw new Error('Use a 6-digit PIN.');
      }

      // Establish the old key. Either re-derive it from the PIN the user just
      // typed, or use the live one if they got in with a recovery code.
      let oldKey: Uint8Array;
      if (currentPassphrase !== null) {
        oldKey = await deriveVaultKey(currentPassphrase, profile.vault_salt);
        if (!checkVerifier(oldKey, profile.vault_verifier)) {
          wipe(oldKey);
          throw new Error('Your current PIN is not correct.');
        }
      } else {
        const live = keyRef.current;
        if (!live) throw new Error('Unlock the vault first.');
        oldKey = live;
      }

      const newSalt = generateSalt();
      const newKey = await deriveVaultKey(nextPassphrase, newSalt);
      const newRecoveryCode = generateRecoveryCode();
      const newRecoveryBlob = await wrapKeyWithRecoveryCode(newKey, newRecoveryCode, newSalt);

      // Rewrite the data BEFORE swapping the salt and verifier. If this throws
      // partway, the profile still describes the old key, so the rows that were
      // already rewritten are the only casualties — and the user can retry.
      // Doing it the other way round would lock them out of everything.
      await reencryptAllAccounts(oldKey, newKey);

      await persistVaultFields({
        vault_salt: newSalt,
        vault_verifier: buildVerifier(newKey),
        vault_recovery_blob: newRecoveryBlob,
      });

      if (currentPassphrase !== null) wipe(oldKey);
      keyRef.current = newKey;
      setStatus('unlocked');

      // The cached key is now stale; re-cache under the new key if biometrics
      // were on, otherwise clear it.
      if (await isBiometricUnlockEnabled()) {
        await cacheVaultKey(newKey).catch(() => clearCachedVaultKey());
      } else {
        await clearCachedVaultKey();
      }

      return newRecoveryCode;
    },
    [persistVaultFields],
  );

  const enableBiometrics = useCallback(async () => {
    const key = keyRef.current;
    if (!key) throw new Error('Unlock the vault before turning on biometric unlock.');
    await cacheVaultKey(key);
    setBiometricsEnabled(true);
  }, []);

  const disableBiometrics = useCallback(async () => {
    await clearCachedVaultKey();
    setBiometricsEnabled(false);
  }, []);

  const setAutoLockMinutes = useCallback<VaultContextValue['setAutoLockMinutes']>(
    async (minutes) => {
      await persistVaultFields({ auto_lock_minutes: minutes });
      setAutoLockMinutesState(minutes);
    },
    [persistVaultFields],
  );

  const getKey = useCallback(() => keyRef.current, []);

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      autoLockMinutes,
      biometricsEnabled,
      unlock,
      unlockWithBiometrics,
      unlockWithRecoveryCode,
      changePassphrase,
      initialise,
      enableBiometrics,
      disableBiometrics,
      setAutoLockMinutes,
      lock,
      getKey,
      refresh: loadProfile,
    }),
    [
      status,
      autoLockMinutes,
      biometricsEnabled,
      unlock,
      unlockWithBiometrics,
      unlockWithRecoveryCode,
      changePassphrase,
      initialise,
      enableBiometrics,
      disableBiometrics,
      setAutoLockMinutes,
      lock,
      getKey,
      loadProfile,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error('useVault must be used inside <VaultProvider>');
  return ctx;
}

/**
 * For lib/db: get the key or fail loudly. Screens should never call this — they
 * go through the db helpers, which is what keeps encryption off the UI layer.
 */
export function requireKey(getKey: () => Uint8Array | null): Uint8Array {
  const key = getKey();
  if (!key) throw new Error('The vault is locked.');
  return key;
}
