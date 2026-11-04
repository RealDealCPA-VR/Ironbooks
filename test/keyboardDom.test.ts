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

  it('lists, registers, reports, pickers, menus and the window keys', async () => {
    expectAllPassed(await runDomFile('test/dom/keyboardLists.dom.tsx'));
  }, 180_000);

  it('the shell: leave-this-form guard, F5, browser keys, Esc, Enter preference, Help, Product Information, menu bar', async () => {
    expectAllPassed(await runDomFile('test/dom/keyboardShell.dom.tsx'));
  }, 180_000);

  it('review leftovers: calendar to-do delete asks, memorized report load failure, conversion rates', async () => {
    expectAllPassed(await runDomFile('test/dom/keyboardLeftovers.dom.tsx'));
  }, 180_000);

  it('partial dates and name fields with Quick Add', async () => {
    expectAllPassed(await runDomFile('test/dom/nameFieldDates.dom.tsx'));
  }, 180_000);

  it('Ctrl+G opens the other register at the transaction, however old', async () => {
    expectAllPassed(await runDomFile('test/dom/registerGoTo.dom.tsx'));
  }, 180_000);

  it('Chart of Accounts: one list across the account types; type-ahead on the number or the name', async () => {
    expectAllPassed(await runDomFile('test/dom/chartOfAccounts.dom.tsx'));
  }, 180_000);

  it('Customer / Vendor Center: arrows and type-ahead choose the name, the right side follows', async () => {
    expectAllPassed(await runDomFile('test/dom/centerView.dom.tsx'));
  }, 180_000);
});
