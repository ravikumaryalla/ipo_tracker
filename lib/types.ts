/**
 * Database types.
 *
 * Hand-written to match supabase/migrations/*.sql. Once your Supabase project
 * exists you can regenerate this file from the live schema, which is the
 * authoritative version:
 *
 *   npx supabase gen types typescript --project-id <ref> > lib/types.ts
 */

export type IpoSegment = 'MAINBOARD' | 'SME';
export type IpoStatus = 'UPCOMING' | 'OPEN' | 'CLOSED' | 'LISTED' | 'WITHDRAWN';
export type ApplicationCategory =
  | 'RETAIL'
  | 'SHNI'
  | 'BHNI'
  | 'SHAREHOLDER'
  | 'EMPLOYEE'
  | 'POLICYHOLDER';
export type ApplicationStatus =
  | 'APPLIED'
  | 'ALLOTTED'
  | 'PARTIAL'
  | 'NOT_ALLOTTED'
  | 'WITHDRAWN'
  | 'REFUNDED';

export type Profile = {
  id: string;
  display_name: string | null;
  vault_salt: string | null;
  vault_verifier: string | null;
  vault_recovery_blob: string | null;
  auto_lock_minutes: number;
  created_at: string;
  updated_at: string;
};

export type Broker = {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  created_at: string;
};

/**
 * A demat account exactly as it sits in Postgres: every sensitive field is
 * base64(nonce || ciphertext). Screens should never touch this shape directly —
 * go through lib/db/accounts.ts, which decrypts on the way out.
 */
export type DematAccountRow = {
  id: string;
  user_id: string;
  broker_id: string | null;
  nickname: string;
  client_id_enc: string | null;
  dp_id_enc: string | null;
  bo_id_enc: string | null;
  email_enc: string | null;
  phone_enc: string | null;
  password_enc: string | null;
  mpin_enc: string | null;
  upi_id_enc: string | null;
  linked_bank_enc: string | null;
  /** Deliberately unencrypted — see 20260811000007_pan_plaintext.sql. */
  pan: string | null;
  /** Legacy encrypted PAN, kept only as the source for the one-time client-side migration to `pan`. */
  pan_enc: string | null;
  notes_enc: string | null;
  is_active: boolean;
  opened_on: string | null;
  password_changed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Ipo = {
  id: string;
  symbol: string;
  company_name: string;
  exchange: string;
  segment: IpoSegment;
  status: IpoStatus;
  open_date: string | null;
  close_date: string | null;
  allotment_date: string | null;
  listing_date: string | null;
  price_band_min: number | null;
  price_band_max: number | null;
  lot_size: number | null;
  issue_size_cr: number | null;
  listing_price: number | null;
  current_price: number | null;
  registrar: string | null;
  registrar_url: string | null;
  /** KFintech's internal clientId for this issue's allotment-status lookup. Null unless matched. */
  kfintech_company_id: string | null;
  source: string;
  created_by: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type IpoApplication = {
  id: string;
  user_id: string;
  ipo_id: string;
  demat_account_id: string;
  category: ApplicationCategory;
  lots: number;
  bid_price: number;
  shares_applied: number;
  amount_blocked: number;
  application_no: string | null;
  upi_ref: string | null;
  applied_at: string;
  status: ApplicationStatus;
  shares_allotted: number;
  allotment_checked_at: string | null;
  sell_price: number | null;
  sold_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ApplicationPnl = {
  id: string;
  user_id: string;
  ipo_id: string;
  demat_account_id: string;
  category: ApplicationCategory;
  status: ApplicationStatus;
  lots: number;
  bid_price: number;
  shares_applied: number;
  amount_blocked: number;
  shares_allotted: number;
  applied_at: string;
  sell_price: number | null;
  sold_at: string | null;
  symbol: string;
  company_name: string;
  segment: IpoSegment;
  open_date: string | null;
  close_date: string | null;
  allotment_date: string | null;
  listing_date: string | null;
  listing_price: number | null;
  current_price: number | null;
  account_nickname: string;
  amount_invested: number;
  amount_currently_blocked: number;
  realised_pnl: number;
  unrealised_pnl: number;
  kfintech_company_id: string | null;
};

export type CredentialHistoryRow = {
  id: string;
  user_id: string;
  demat_account_id: string;
  field: string;
  old_value_enc: string;
  changed_at: string;
};

export type SyncLogRow = {
  id: string;
  provider: string;
  ok: boolean;
  rows_upserted: number;
  message: string | null;
  ran_at: string;
};

/**
 * One grey market premium reading. Unofficial, unregulated data — anything
 * rendering it must say so. `ipo_id` is null while a reading has not been
 * matched to an IPO yet; sync-ipos retries those on every run.
 */
export type IpoGmp = {
  id: string;
  ipo_id: string | null;
  provider: string;
  provider_slug: string;
  company_name: string;
  open_date: string | null;
  observed_at: string;
  gmp: number | null;
  gmp_percent: number | null;
  price: number | null;
  sub_times: number | null;
  source_url: string | null;
  synced_at: string;
  created_at: string;
};

type TableShape<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      profiles: TableShape<Profile>;
      brokers: TableShape<Broker>;
      demat_accounts: TableShape<DematAccountRow>;
      ipos: TableShape<Ipo>;
      ipo_gmp: TableShape<IpoGmp>;
      ipo_applications: TableShape<IpoApplication>;
      credential_history: TableShape<CredentialHistoryRow>;
      sync_log: TableShape<SyncLogRow>;
    };
    Views: {
      v_application_pnl: { Row: ApplicationPnl; Relationships: [] };
    };
    Functions: Record<string, never>;
    Enums: {
      ipo_segment: IpoSegment;
      ipo_status: IpoStatus;
      application_category: ApplicationCategory;
      application_status: ApplicationStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};
