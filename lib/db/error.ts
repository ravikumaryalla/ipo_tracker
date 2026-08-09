/**
 * Supabase returns `PostgrestError` as a plain object, not an `Error` subclass.
 * Throwing it raw means anything that stringifies the failure — a console log,
 * React Query's devtools, an error boundary — renders `[object Object]` and the
 * actual cause is lost. A missing table (`PGRST205`) and an RLS rejection
 * (`42501`) look identical, which is exactly when you most need to tell them
 * apart.
 *
 * So every database call wraps its error in a real `Error` carrying the code.
 */
import type { PostgrestError } from '@supabase/supabase-js';

export function dbError(error: PostgrestError): Error {
  const detail = [error.details, error.hint].filter(Boolean).join(' — ');
  return new Error(`[${error.code}] ${error.message}${detail ? ` (${detail})` : ''}`);
}
