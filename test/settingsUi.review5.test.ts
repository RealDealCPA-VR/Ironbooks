/**
 * Review round 5 (team uib): Preferences.
 *
 *  - Preferences > Sales & Customers showed "Next Invoice Number" as the largest integer invoice
 *    number + 1, computed by downloading every invoice in the company file. Invoice numbers carry
 *    letters and a starting number (Document Numbers, lib/services/docNumbers.ts), so after
 *    "INV-0099" it said "#100" instead of INV-0100, and after a starting number of INV-2000 it
 *    still said "#100". It now shows what the numbering service will hand out.
 *
 * The page itself runs in a real browser window (test/dom/settingsPrefs.dom.tsx) against stubbed
 * API answers: the box shows the service's answer and the invoice list is never requested.
 */
import { describe, expect, it } from 'vitest';
import { incrementAlnum } from '@/lib/services/docNumbers';
import { expectAllPassed, runDomFile } from './domHarness';

describe('Preferences: next invoice number', () => {
  it('the numbering service hands out INV-0100 after INV-0099', () => {
    expect(incrementAlnum('INV-0099')).toBe('INV-0100');
  });

  it('the Preferences page shows the service’s next number and never downloads the invoice list', async () => {
    expectAllPassed(await runDomFile('test/dom/settingsPrefs.dom.tsx'), [
      'shows the number the numbering service hands out next (INV-0100 after INV-0099)',
      'a starting number set in Document Numbers is shown as is, whatever the invoices say',
      'when the numbering service cannot answer, the box says N/A rather than guessing',
    ]);
  }, 180_000);
});
