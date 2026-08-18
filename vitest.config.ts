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
    /*
     * DSP sweeps are legitimately heavy: rendering seconds of audio across every
     * parameter at both extremes is real compute, not a hang. The 5s default is
     * a web-app default and it was failing honest tests at random depending on
     * machine load. Assertion-per-sample loops are being removed separately —
     * that was the other half of the problem.
     */
    testTimeout: 30_000,
  },
  resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
});
