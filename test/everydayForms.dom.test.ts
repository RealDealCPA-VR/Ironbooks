/**
 * Everyday transaction forms in a real browser window (test/dom/everydayForms.dom.tsx): invoice
 * due date follows the date, unknown items are refused, blank grid lines are left out (bills,
 * deposits), credit memo Class / Customer:Job, Subtotal items on credit memos and sales receipts.
 */
import { describe, it } from 'vitest';
import { expectAllPassed, runDomFile } from './domHarness';

describe('everyday transaction forms in the browser', () => {
  it('invoices, bills, deposits, credit memos and sales receipts', async () => {
    expectAllPassed(await runDomFile('test/dom/everydayForms.dom.tsx'), [
      'Invoice: a new date moves the terms due date; an Item not on the list is refused',
      'Bill: Enter on the last line adds a blank line, and the bill still saves without it',
      'Deposit: a blank additional line is left out instead of blocking the save',
      'Credit memo: Class and Customer:Job load and are sent; a Subtotal item saves',
      'Sales receipt: a Subtotal item saves (it has no price)',
    ]);
  }, 180_000);
});
