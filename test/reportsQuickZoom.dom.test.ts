/**
 * Reports post-merge fixes: QuickZoom from a report to a bill payment (test/dom/reportsQuickZoom.dom.tsx,
 * run in a hidden Electron window by test/domHarness.ts).
 */
import { describe, it } from 'vitest';
import { expectAllPassed, runDomFile } from './domHarness';

describe('QuickZoom to a bill payment (/pay-bills?open=)', () => {
  it('opens it with its vendor loaded (Save works); a discounted payment opens read-only', async () => {
    expectAllPassed(await runDomFile('test/dom/reportsQuickZoom.dom.tsx'), [
      'a bill payment opened from a report is saved with its own vendor',
      'a payment that took an early-payment discount opens read-only with the reason',
    ]);
  }, 180_000);
});
