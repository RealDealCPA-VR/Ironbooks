import { defineConfig } from 'vitest/config';
import path from 'node:path';

// A company with no time zone set uses the PC's zone (lib/preferences localTimeZone). The tests were
// written on a New York PC, so every run (CI runs in UTC) uses that zone; tests that need another
// zone pin the clock and the company zone themselves. Workers inherit this.
process.env.TZ = 'America/New_York';

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
