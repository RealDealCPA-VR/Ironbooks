/**
 * salesar (post-merge review): Void / Delete of estimates, sales orders and POs is reachable from
 * the form (Ctrl+D) and the row, with QB's confirmation; Memorize (Ctrl+M) is on the estimate,
 * sales order and vendor credit forms. Real pages in a browser window (test/dom/salesarForms.dom.tsx).
 */
import { describe, it } from 'vitest';
import { expectAllPassed, runDomFile } from './domHarness';

describe('salesar forms in the browser', () => {
  it('void / delete and memorize on estimates, sales orders, purchase orders and vendor credits', async () => {
    expectAllPassed(await runDomFile('test/dom/salesarForms.dom.tsx'));
  }, 180_000);
});
