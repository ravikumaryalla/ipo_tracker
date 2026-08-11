-- Replace the generic Username / Transaction password login fields with the
-- ones brokers actually ask for: email, phone number, password, MPIN.
--
-- `username_enc` and `txn_password_enc` are renamed rather than dropped and
-- recreated — the rename is metadata-only, so whatever ciphertext already
-- sits in those columns keeps decrypting exactly as before under its new
-- name. `phone_enc` is genuinely new, so that one gets added.

alter table public.demat_accounts rename column username_enc to email_enc;
alter table public.demat_accounts rename column txn_password_enc to mpin_enc;
alter table public.demat_accounts add column phone_enc text;

comment on column public.demat_accounts.email_enc is 'Login email for the broker/DP portal.';
comment on column public.demat_accounts.phone_enc is 'Login phone number for the broker/DP portal.';
comment on column public.demat_accounts.mpin_enc  is 'MPIN, the short numeric password brokers ask for at login or order placement.';
