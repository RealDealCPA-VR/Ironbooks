/**
 * Review loop 9 fixes (statements):
 *  - a customer's statement includes its jobs, with one running balance (both formats);
 *  - batch statements: one per customer (jobs on it), inactive customers who owe included.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { customers } from '@/lib/db/schema';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { batchStatements, customerStatement, openItemStatement } from './statements';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

beforeAll(async () => {
  t = await makeTestCompany('review9');
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('statements', { timeout: 120_000 }, () => {
  it("a customer's statement carries its jobs", async () => {
    const acme = await createCustomer(t.ctx, { displayName: 'Acme R9' });
    const kitchen = await createCustomer(t.ctx, { displayName: 'Acme R9:Kitchen', parentId: acme.id });
    await createInvoice(t.ctx, { customerId: acme.id, date: d('2026-03-01'), lines: [{ accountId: t.acct['4000'], description: 'Own', quantity: 1, rate: 100 }] } as never);
    await createInvoice(t.ctx, { customerId: kitchen.id, date: d('2026-03-05'), lines: [{ accountId: t.acct['4000'], description: 'Job', quantity: 1, rate: 250 }] } as never);

    const st = await customerStatement(t.ctx, acme.id, { from: d('2026-03-01'), to: d('2026-03-31') });
    expect(st.closingBalance).toBe('350.00');
    expect(st.lines.map((l) => l.runningBalance)).toEqual(['100.00', '350.00']);
    const oi = await openItemStatement(t.ctx, acme.id, d('2026-03-31'));
    expect(oi.totalDue).toBe('350.00');

    // Inactive but still owing: it gets its statement; the job is on its customer's.
    await t.db.update(customers).set({ isActive: false }).where(eq(customers.id, acme.id));
    const batch = await batchStatements(t.ctx, { format: 'balance_forward', from: d('2026-03-01'), to: d('2026-03-31') } as never);
    expect(batch.some((b) => b.customerId === acme.id)).toBe(true);
    expect(batch.some((b) => b.customerId === kitchen.id)).toBe(false);
  });
});
