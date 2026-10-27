/**
 * Review round 5 — "Filled in from the last invoice #… " names the number printed on that form
 * (the typed ref number, e.g. INV-1017), not the internal sequence number. Before the fix a
 * customer whose last invoice was INV-R5-42 got "Filled in from the last invoice #42".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSmartDefaults } from './smartDefaults';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createSalesReceipt } from './salesReceipts';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('r5-smart');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('review5: smart defaults source number', () => {
  it('invoice and sales receipt recall show the typed number', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'R5 Recall Customer' });
    await createInvoice(t.ctx, {
      customerId: c.id,
      refNumber: 'INV-R5-42',
      date: new Date('2026-04-02T00:00:00.000Z'),
      lines: [{ description: 'Work', quantity: 1, rate: '100.00', accountId: t.acct['4000'] }],
    });
    const inv = await getSmartDefaults(t.ctx, { form: 'invoice', customerId: c.id });
    expect(inv.source?.number).toBe('INV-R5-42');

    await createSalesReceipt(t.ctx, {
      customerId: c.id,
      refNumber: 'SR-R5-7',
      date: new Date('2026-04-03T00:00:00.000Z'),
      depositAccountId: t.acct['1000'],
      lines: [{ description: 'Counter', quantity: 1, rate: '20.00', accountId: t.acct['4000'] }],
    } as never);
    const sr = await getSmartDefaults(t.ctx, { form: 'sales_receipt', customerId: c.id });
    expect(sr.source?.number).toBe('SR-R5-7');
  });
});
