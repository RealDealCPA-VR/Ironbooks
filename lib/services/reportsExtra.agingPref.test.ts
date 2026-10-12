/**
 * Preferences > Reports: "Aging reports: age from due date / transaction date" (wave2 prefs).
 * The same invoice lands in a different A/R aging bucket depending on the preference.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { updateCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { arAging, arAgingDetail } from './reportsExtra';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('agingpref');
  const c = await createCustomer(t.ctx, { displayName: 'Aging Customer' });
  // Dated Jan 1, due Mar 2; aged as of Mar 12 → 10 days past due, 70 days since the invoice date.
  await createInvoice(t.ctx, {
    customerId: c.id,
    date: new Date('2026-01-01T00:00:00Z'),
    dueDate: new Date('2026-03-02T00:00:00Z'),
    lines: [{ description: 'Consulting', quantity: '1', rate: '100.00' }],
  });
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

const asOf = new Date('2026-03-12T00:00:00Z');

describe('aging basis preference', () => {
  it('ages from the due date by default', async () => {
    const r = await arAging(t.ctx, asOf);
    expect(r.rows[0].days1_30).toBe('100.00');
    expect(r.rows[0].days61_90).toBe('0.00');
    const d = await arAgingDetail(t.ctx, asOf);
    expect(d.rows[0].daysPastDue).toBe(10);
  });

  it('ages from the transaction date when the preference says so', async () => {
    await updateCompany(t.ctx, { settings: { agingFrom: 'transaction_date' } });
    const r = await arAging(t.ctx, asOf);
    expect(r.rows[0].days61_90).toBe('100.00');
    expect(r.rows[0].days1_30).toBe('0.00');
    const d = await arAgingDetail(t.ctx, asOf);
    expect(d.rows[0].daysPastDue).toBe(70);
  });
});
