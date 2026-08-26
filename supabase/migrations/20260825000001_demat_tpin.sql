-- The CDSL/NSDL TPIN, used to authorise a debit of shares out of the demat
-- account. A credential like mpin_enc, so it gets the same client-side
-- encryption — no server-side function needs it, so it does NOT get the
-- plaintext exception that `pan` was given in 20260811000007.
alter table public.demat_accounts add column tpin_enc text;

comment on column public.demat_accounts.tpin_enc is
  'CDSL/NSDL TPIN used to authorise share debits. base64(nonce || ciphertext), encrypted with the user vault key on-device.';
