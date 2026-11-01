import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    pool: 'forks',
    // Never let a developer's shell setting point tests at the real OS keychain.
    env: { SEARVEX_CREDENTIAL_STORE: 'file' },
  },
});
