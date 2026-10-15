import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  // Component tests (react-dom/server) need the TSX transform; tsconfig keeps jsx: preserve for Next.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'test/**/*.test.ts'],
    // PGlite's WASM boot + first migration can be slow on a cold run.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
