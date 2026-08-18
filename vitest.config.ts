import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The allocation test needs a real gc(). `pnpm test` sets
    // NODE_OPTIONS=--expose-gc so forked workers inherit it.
    pool: 'forks',
  },
  resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
});
