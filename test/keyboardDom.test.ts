/**
 * QuickBooks keys pressed in a real browser engine (test/domHarness.ts runs each file in a hidden
 * Electron window with DevTools key presses): field and form keys, lists and pickers, the window
 * keys and the leave-this-form guard.
 */
import { describe, it } from 'vitest';
import { expectAllPassed, runDomFile } from './domHarness';

describe('QuickBooks keys in the browser', () => {
  it('fields and forms: date keys, form numbers, Esc / Enter, line copy, Tab order', async () => {
    expectAllPassed(await runDomFile('test/dom/keyboardForms.dom.tsx'));
  }, 180_000);
});
