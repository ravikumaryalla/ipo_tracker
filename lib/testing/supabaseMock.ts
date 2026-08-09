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
const notStubbed = () => {
  throw new Error(
    'supabase client is not available in unit tests — test the pure encryption ' +
      'boundary, or add an explicit stub for this query.',
  );
};

export const supabase = new Proxy({} as never, { get: notStubbed });
