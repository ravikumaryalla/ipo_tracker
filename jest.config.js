/**
 * The crypto core is pure TypeScript with no React Native imports, so it runs
 * under ts-jest in Node — much faster and more reliable than booting the
 * react-native preset just to test key derivation.
 *
 * ESM mode is deliberate. @noble/* ship ESM only; transpiling them down to
 * CommonJS deoptimises their 64-bit arithmetic loops badly enough that Argon2id
 * goes from ~1.6s to well over a minute per derivation. Running them as native
 * ESM keeps the suite fast. Requires --experimental-vm-modules, wired up in the
 * `test` script.
 */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/lib/**/*.test.ts'],
  // Argon2id at 64 MiB takes seconds by design; several tests derive keys.
  testTimeout: 60_000,
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // ts-jest ESM needs relative specifiers resolved without the .js suffix.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Unit tests exercise the pure encryption boundary, not the network. This
    // keeps them from booting the real Supabase client and its RN polyfills.
    '^\\.\\./supabase$': '<rootDir>/lib/testing/supabaseMock.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          target: 'es2022',
          esModuleInterop: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
};
