import { describe, it } from 'vitest';
import { expectAllPassed, runDomFile } from './domHarness';

describe('dom harness smoke', () => {
  it('runs', async () => {
    expectAllPassed(await runDomFile('test/dom/smoke.dom.tsx'));
  }, 180_000);
});
