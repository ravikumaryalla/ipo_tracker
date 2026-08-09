# IPO Tracker

An Android app for tracking demat accounts, their credentials, and IPO applications.

Passwords are encrypted **on the phone** before they are stored. The Postgres database
holds ciphertext only — a full breach of the Supabase project exposes no credentials.

- **App** — React Native + Expo (expo-router), built to an APK via EAS cloud
- **Backend** — Supabase: Postgres, auth, Row Level Security, Edge Functions
- **Crypto** — Argon2id key derivation + XChaCha20-Poly1305, via `@noble/*`

---

## Security model

Two secrets that never mix:

```
login password   ──► Supabase Auth ──► JWT + refresh token
master passphrase ─► Argon2id(64 MiB, t=3, per-user salt) ─► vault key (32 bytes)
                        │
                        └─► XChaCha20-Poly1305 ─► base64(nonce ‖ ciphertext)
                                                        ↓
                                              Postgres `*_enc` columns
```

Properties this buys, and where they are enforced:

| Property | Where |
|---|---|
| Master passphrase never leaves the device | `lib/crypto/primitives.ts` |
| Only `lib/db/accounts.ts` converts plaintext ⇄ ciphertext | enforced by module boundary + tests |
| Wrong passphrase detected immediately | `vault_verifier` in `profiles` |
| Cached key sits in the Android Keystore behind biometrics | `lib/crypto/secureStore.ts` |
| Auto-lock on foreground after N minutes idle | `lib/vault.tsx` |
| Plaintext never written to AsyncStorage | `shouldDehydrateQuery` in `app/_layout.tsx` |
| Locking purges decrypted rows from the query cache | `app/_layout.tsx` |
| Screenshots blocked while a secret is visible | `components/SecretField.tsx` |
| Clipboard cleared 30s after a copy | `components/SecretField.tsx` |
| Second line of defence if encryption were bypassed | RLS, `supabase/migrations/…_rls.sql` |

**Losing the master passphrase means losing the encrypted data.** The printable recovery
code generated at setup is the only way back in.

---

## Setup

### 1. Supabase project

Create a project at [supabase.com](https://supabase.com), then:

```bash
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase db push          # applies supabase/migrations/*.sql
```

Copy `.env.example` to `.env` and fill in the project URL and **anon** key
(Dashboard → Settings → API). The anon key is safe to ship — RLS guards every table.

### 2. IPO auto-sync (optional but recommended)

```bash
npx supabase functions deploy sync-ipos
npx supabase functions invoke sync-ipos     # verify it works before scheduling
```

Then set the two database settings named at the top of
`supabase/migrations/20260810000002_cron.sql` and apply that migration. It schedules two
jobs — 04:00 UTC (09:30 IST) and 13:30 UTC (19:00 IST) — bracketing the market day. Two
jobs rather than one because a cron expression has a single minute field and those times
differ in their minute. The service-role key lives only in the database and in Supabase
secrets — never in `.env`, never in the app bundle.

The sync pulls three sources in order — NSE, BSE, then Chittorgarh — each independent of
the next, plus grey market premium readings into `ipo_gmp`. Chittorgarh runs last because
it is the only source that supplies a listing date.

> **Expect this to break eventually.** None of these sites publishes a documented IPO API;
> `sync-ipos` calls the endpoints their own front-ends use. Every attempt is written to
> `sync_log`, the app shows a staleness banner from it, and **Add IPO manually** always
> works. Allotment status is deliberately not scraped — registrar sites are captcha-walled,
> so the app reminds you and links out instead.
>
> **On GMP.** Grey market premium is unofficial dealer chatter, not exchange data. SEBI has
> publicly cautioned retail investors against relying on it, and it is manipulable on
> thinly-traded SME issues. The app stores it as a time series and always renders it with a
> disclaimer. Keep the sync at twice daily and attribute the source; scraping these
> endpoints is defensible for personal use and stops being so if you redistribute the data
> or raise the frequency.

### 3. Run it

```bash
npm install
npx expo start          # then open in Expo Go on your phone
```

### 4. Build the APK

```bash
npm install -g eas-cli
eas login
eas build:configure                        # fills in the real projectId in app.json
# put your real Supabase values into the `preview` env block in eas.json
eas build -p android --profile preview
```

Biometric unlock and screenshot blocking only behave correctly in a real build —
verify those on the APK, not in Expo Go.

---

## Testing

```bash
npm test          # 55 tests
npm run typecheck
```

The suite covers the parts where a bug is expensive: key derivation, encrypt/decrypt
round-trips, tamper detection, the recovery code, the plaintext-never-leaves-the-boundary
guarantee in `lib/db/accounts.ts`, IPO date bucketing, dashboard maths, and reminder rules.

Tests derive keys with `TEST_KDF_PARAMS` (cheap on purpose — Jest's VM sandbox makes
production-cost Argon2id take minutes). A dedicated test asserts the **production**
parameters still meet the OWASP floor, so the shortcut cannot silently weaken the app.

### Verifying the zero-knowledge claim yourself

Worth doing once, by hand. Add an account with a password, then in the Supabase SQL editor:

```sql
select nickname, password_enc from demat_accounts;
```

`nickname` is readable; `password_enc` is base64 noise. That is the whole design in one query.

To check RLS, sign in as a second user and confirm `select * from demat_accounts`
returns zero rows belonging to the first.

---

## Layout

```
app/                      expo-router screens
  (auth)/                 sign-in, sign-up, forgot-password
  vault/                  setup (passphrase + recovery code), unlock
  (tabs)/                 dashboard, accounts, ipos, applications
  accounts/ ipos/ applications/ settings/
lib/
  crypto/primitives.ts    KDF, AEAD, recovery code — pure, fully tested
  crypto/secureStore.ts   Keystore-backed key cache + biometrics
  vault.tsx               lock state, auto-lock, re-keying
  auth.tsx                Supabase session
  db/                     the ONLY place plaintext becomes ciphertext
  reminders.ts            pure reminder rules
components/               SecretField, AccountForm, ui primitives
supabase/
  migrations/             schema, RLS, P&L view, broker seed, GMP, cron
  functions/sync-ipos/    NSE → BSE → Chittorgarh chain, plus GMP
    parse.ts              pure parsing + matching — the tested part
```

The rule worth keeping: **encryption happens in `lib/db/`, never in a screen.**
