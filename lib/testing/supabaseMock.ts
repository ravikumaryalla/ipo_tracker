/**
 * Stand-in for lib/supabase.ts in unit tests.
 *
 * The db modules only touch the network inside their exported query functions;
 * the encryption boundary we actually want to test is pure. Swapping the client
 * out here keeps the test suite from booting the real Supabase client and the
 * React Native URL polyfill it imports.
 *
 * Any test that calls through to a query function will fail loudly rather than
 * silently pretending to talk to a database.
 */
const notStubbed = (): never => {
  throw new Error(
    'supabase client is not available in unit tests — test the pure encryption ' +
      'boundary, or add an explicit stub for this query.',
  );
};

let stub: Record<string | symbol, unknown> | null = null;

/**
 * Opt a single test into a hand-written client. Used where the assertion is
 * about the payload a db function *sends* — e.g. that saving an outcome by hand
 * does not also stamp allotment_checked_at. Pair with clearSupabaseStub in an
 * afterEach so the loud default is restored for everything else.
 */
export function setSupabaseStub(next: Record<string | symbol, unknown>): void {
  stub = next;
}

export function clearSupabaseStub(): void {
  stub = null;
}

export const supabase = new Proxy({} as never, {
  get: (_target, prop) => (stub ? stub[prop] : notStubbed()),
});
