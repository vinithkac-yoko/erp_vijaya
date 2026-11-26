import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** `pnpm eval`: the agent evals. Calls the real model, so it is never part of `pnpm test` or CI (evals/README.md). */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['evals/runner.eval.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
