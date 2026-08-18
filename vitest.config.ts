import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The allocation test needs a real gc(). `pnpm test` sets
    // NODE_OPTIONS=--expose-gc so forked workers inherit it.
    pool: 'forks',
    /*
     * Serial. The CPU budget gate measures wall-clock DSP cost, and parallel
     * file execution made it contend with other workers — it read 8.3x the
     * reference alone and 12.4x under load, which is scheduler noise rather
     * than engine cost. The whole suite runs in a few seconds either way, so
     * determinism is worth more than the parallelism.
     */
    fileParallelism: false,
  },
  resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
});
