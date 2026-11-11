import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    pool: 'forks',
    // Never let a developer's shell setting point tests at the real OS keychain or route them through a real
    // proxy (empty values count as unset).
    env: { SEARVEX_CREDENTIAL_STORE: 'file', HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', NO_PROXY: '', no_proxy: '' },
  },
});
