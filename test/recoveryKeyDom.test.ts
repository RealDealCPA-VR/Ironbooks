/**
 * The recovery key screen in a real browser engine (test/domHarness.ts: a hidden Electron window):
 * Print… prints from the page itself (the desktop app refuses blank pop-up windows), Save to a
 * File… saves through the desktop bridge.
 */
import { describe, it } from 'vitest';
import { expectAllPassed, runDomFile } from './domHarness';

describe('the recovery key: Print and Save to a File', () => {
  it('prints the key on its own sheet without a pop-up window, and saves it as a text file', async () => {
    expectAllPassed(await runDomFile('test/dom/recoveryKey.dom.tsx'));
  }, 180_000);
});
