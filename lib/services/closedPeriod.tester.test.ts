/**
 * P1 controls — independent tester: QB requires the closing-date password for ANY change to a
 * transaction dated on/before the closing date. Probe update paths beyond memo-only edits:
 *  - payee change on a check, line description on a deposit (ledger-neutral);
 *  - memo-only edits of invoices and customer payments (void/repost paths);
 *  - assigning a sales rep to a closed-period invoice (header-only update path, salesReps.ts);
 *  - with the password the edit lands, the ledger is untouched and TB stays balanced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { invoices } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { postJournalEntry } from './posting';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createExpense, updateExpense } from './expenses';
import { createDeposit, updateDeposit } from './deposits';
import { createInvoice, updateInvoice } from './invoices';
import { receivePayment, updatePayment } from './payments';
import { createSalesRep, assignRepToInvoice } from './salesReps';
import { setClosingDate } from './company';
import { trialBalance } from './reports';
import { closingDateExceptionReport } from './accountant/auditReports';

let t: TestCompany;
let over: ServiceContext;
let vendorA: string;
let vendorB: string;
let customerId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);

beforeAll(async () => {
  t = await makeTestCompany('p1-tester-closed');
  over = { ...t.ctx, closingDateOverride: true };
  vendorA = (await createVendor(t.ctx, { displayName: 'Vendor A' } as never)).id;
  vendorB = (await createVendor(t.ctx, { displayName: 'Vendor B' } as never)).id;
  customerId = (await createCustomer(t.ctx, { displayName: 'Closed Customer' } as never)).id;
  await postJournalEntry(t.ctx, {
    date: D('2026-01-01'),
    description: 'Opening',
    lines: [
      { accountId: t.acct['1000'], debit: '5000.00' },
      { accountId: t.acct['3900'], credit: '5000.00' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('closing date covers every change to a closed-period transaction', () => {
  it('payee change on a check and a line description on a deposit need the password', async () => {
    const exp = await createExpense(t.ctx, {
      vendorId: vendorA,
      date: D('2026-01-10'),
      method: 'check',
      reference: '501',
      paymentAccountId: t.acct['1000'],
      lines: [{ accountId: t.acct['6300'], amount: '19.99' }],
    });
    const dep = await createDeposit(t.ctx, {
      depositAccountId: t.acct['1000'],
      date: D('2026-01-12'),
      extraLines: [{ accountId: t.acct['4900'], amount: '33.33' }],
    } as never);
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    const tbBefore = await trialBalance(t.ctx, D('2026-12-31'));

    const payee = (c: ServiceContext) =>
      updateExpense(c, exp.id, {
        vendorId: vendorB,
        date: D('2026-01-10'),
        method: 'check',
        reference: '501',
        paymentAccountId: t.acct['1000'],
        lines: [{ accountId: t.acct['6300'], amount: '19.99' }],
      });
    const desc = (c: ServiceContext) =>
      updateDeposit(c, dep.id, {
        depositAccountId: t.acct['1000'],
        date: D('2026-01-12'),
        extraLines: [{ accountId: t.acct['4900'], amount: '33.33', description: 'refund from supplier' }],
      } as never);

    await expect(payee(t.ctx)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await expect(desc(t.ctx)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });

    const e2 = await payee(over);
    expect(e2.vendorId).toBe(vendorB);
    await desc(over);

    const tbAfter = await trialBalance(t.ctx, D('2026-12-31'));
    expect(tbAfter.balanced).toBe(true);
    expect(tbAfter.rows).toEqual(tbBefore.rows);
    const rows = (await closingDateExceptionReport(t.ctx)).rows;
    expect(rows.some((r) => r.entryId === e2.postedEntryId || r.entryId === exp.postedEntryId)).toBe(true);
  });

  it('memo-only edits of an invoice and a customer payment in the closed period need the password', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const inv = await createInvoice(t.ctx, {
      customerId,
      date: D('2026-01-15'),
      lines: [{ description: 'Work', quantity: 1, rate: '120.00' }],
    } as never);
    const pay = await receivePayment(t.ctx, {
      customerId,
      date: D('2026-01-16'),
      method: 'check',
      amount: '20.00',
      depositAccountId: t.acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '20.00' }],
    } as never);
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);

    await expect(
      updateInvoice(t.ctx, inv.id, {
        customerId,
        date: D('2026-01-15'),
        memo: 'changed memo',
        lines: [{ description: 'Work', quantity: 1, rate: '120.00' }],
      } as never),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    const payId = pay.payment.id;
    await expect(
      updatePayment(t.ctx, payId, {
        customerId,
        date: D('2026-01-16'),
        method: 'check',
        amount: '20.00',
        memo: 'changed',
        depositAccountId: t.acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '20.00' }],
      } as never),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect((await trialBalance(t.ctx, D('2026-12-31'))).balanced).toBe(true);
  });

  it('assigning a sales rep to a closed-period invoice needs the password (header-only update)', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const inv = await createInvoice(t.ctx, {
      customerId,
      date: D('2026-01-20'),
      lines: [{ description: 'Consulting', quantity: 1, rate: '500.00' }],
    } as never);
    const rep = await createSalesRep(t.ctx, { name: 'Rita Rep', commissionRate: '0.05' } as never);
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);

    // Changing the rep changes the transaction (and the commission report for a closed month).
    await expect(assignRepToInvoice(t.ctx, { invoiceId: inv.id, salesRepId: rep.id })).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
    const [row] = await t.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.salesRepId).toBeNull();

    // With the password it is allowed.
    const ok = await assignRepToInvoice(over, { invoiceId: inv.id, salesRepId: rep.id });
    expect(ok.salesRepId).toBe(rep.id);
  });
});
