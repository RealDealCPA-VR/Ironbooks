/**
 * P1 controls — re-test round 1 (independent tester): closing date on header-only edits.
 *
 * Sales rep assignment (fix ed01ef3):
 *  - removing the rep (null) and switching rep A -> B on a closed-period invoice need the password;
 *  - re-assigning the SAME rep is a no-op: no password, no exception row;
 *  - with the password the change lands, is listed on the Closing Date Exception report, and the
 *    ledger does not move; open-period invoices need no password; another company's invoice is
 *    not found (isolation).
 *
 * Print Checks number assignment (fix d31fe80) — the fixer's test covers Write Checks only:
 *  - bill-payment check and paycheck dated in the closed period need the password, stay queued
 *    when refused, and print with it (exception listed); the TB never moves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { billPayments, employees, invoices, paychecks, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { postJournalEntry } from './posting';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { markPrinted, queuePaychecks } from './printQueue';
import { createSalesRep, assignRepToInvoice } from './salesReps';
import { createCompany, setClosingDate } from './company';
import { trialBalance } from './reports';
import { closingDateExceptionReport } from './accountant/auditReports';

let t: TestCompany;
let over: ServiceContext;
let customerId: string;
let vendorId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const AS_OF = D('2026-12-31');

async function exceptionsFor(entryId: string | null | undefined) {
  return (await closingDateExceptionReport(t.ctx)).rows.filter((r) => r.entryId === entryId).length;
}

beforeAll(async () => {
  t = await makeTestCompany('p1-retest1-closed');
  over = { ...t.ctx, closingDateOverride: true };
  customerId = (await createCustomer(t.ctx, { displayName: 'Rep Customer' } as never)).id;
  vendorId = (await createVendor(t.ctx, { displayName: 'Print Vendor' } as never)).id;
  await postJournalEntry(t.ctx, {
    date: D('2026-01-01'),
    description: 'Opening',
    lines: [
      { accountId: t.acct['1000'], debit: '9000.00' },
      { accountId: t.acct['3900'], credit: '9000.00' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('sales rep assignment on closed-period invoices', () => {
  it('remove / switch need the password; same rep is a no-op; with the password it is listed and the books do not move', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const repA = await createSalesRep(t.ctx, { name: 'Ann Rep', commissionRate: '0.05' } as never);
    const repB = await createSalesRep(t.ctx, { name: 'Ben Rep', commissionRate: '0.10' } as never);
    const inv = await createInvoice(t.ctx, {
      customerId,
      date: D('2026-01-20'),
      lines: [{ description: 'Consulting', quantity: 1, rate: '400.00' }],
    } as never);
    await assignRepToInvoice(t.ctx, { invoiceId: inv.id, salesRepId: repA.id });
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    const tb = (await trialBalance(t.ctx, AS_OF)).rows;
    const exBefore = await exceptionsFor(inv.postedEntryId);

    // Same rep again: nothing changes, so no password and no exception.
    const same = await assignRepToInvoice(t.ctx, { invoiceId: inv.id, salesRepId: repA.id });
    expect(same.salesRepId).toBe(repA.id);
    expect(await exceptionsFor(inv.postedEntryId)).toBe(exBefore);

    await expect(assignRepToInvoice(t.ctx, { invoiceId: inv.id, salesRepId: null })).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
    await expect(assignRepToInvoice(t.ctx, { invoiceId: inv.id, salesRepId: repB.id })).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
    expect((await t.db.select().from(invoices).where(eq(invoices.id, inv.id)))[0].salesRepId).toBe(repA.id);
    expect(await exceptionsFor(inv.postedEntryId)).toBe(exBefore);

    const switched = await assignRepToInvoice(over, { invoiceId: inv.id, salesRepId: repB.id });
    expect(switched.salesRepId).toBe(repB.id);
    expect(await exceptionsFor(inv.postedEntryId)).toBeGreaterThan(exBefore);
    const removed = await assignRepToInvoice(over, { invoiceId: inv.id, salesRepId: null });
    expect(removed.salesRepId).toBeNull();

    const after = await trialBalance(t.ctx, AS_OF);
    expect(after.balanced).toBe(true);
    expect(after.rows).toEqual(tb);
  });

  it('open-period invoices need no password; another company cannot touch the invoice', async () => {
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    const rep = await createSalesRep(t.ctx, { name: 'Cy Rep', commissionRate: '0.05' } as never);
    const inv = await createInvoice(t.ctx, {
      customerId,
      date: D('2026-02-05'),
      lines: [{ description: 'Feb work', quantity: 1, rate: '50.00' }],
    } as never);
    const ok = await assignRepToInvoice(t.ctx, { invoiceId: inv.id, salesRepId: rep.id });
    expect(ok.salesRepId).toBe(rep.id);

    const [u2] = await t.db.insert(users).values({ email: 'retest1-other@test.local', name: 'Other', passwordHash: 'x' }).returning();
    const otherCo = await createCompany(t.db, { name: 'Other Co', ownerId: u2.id });
    await expect(
      assignRepToInvoice({ db: t.db, companyId: otherCo.id, userId: u2.id, closingDateOverride: true }, { invoiceId: inv.id, salesRepId: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await t.db.select().from(invoices).where(eq(invoices.id, inv.id)))[0].salesRepId).toBe(rep.id);
  });
});

describe('Print Checks on closed-period bill payments and paychecks', () => {
  it('a queued closed-period bill-payment check needs the password to get its number', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const bill = await createBill(t.ctx, {
      vendorId,
      date: D('2026-01-05'),
      lines: [{ accountId: t.acct['6300'], amount: '120.00' }],
    } as never);
    const pay = await payBills(t.ctx, {
      vendorId,
      date: D('2026-01-08'),
      method: 'check',
      paymentAccountId: t.acct['1000'],
      toPrint: true,
      applications: [{ billId: bill.id, amountApplied: '120.00' }],
    } as never);
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    const tb = (await trialBalance(t.ctx, AS_OF)).rows;

    await expect(markPrinted(t.ctx, { source: 'bill_payment', id: pay.id, checkNumber: '7101' })).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
    const [still] = await t.db.select().from(billPayments).where(eq(billPayments.id, pay.id));
    expect(still.toPrint).toBe(true);
    expect(still.reference ?? null).toBeNull();

    await markPrinted(over, { source: 'bill_payment', id: pay.id, checkNumber: '7101' });
    const [printed] = await t.db.select().from(billPayments).where(eq(billPayments.id, pay.id));
    expect(printed.toPrint).toBe(false);
    expect(printed.reference).toBe('7101');
    expect(await exceptionsFor(pay.postedEntryId)).toBeGreaterThan(0);
    expect((await trialBalance(t.ctx, AS_OF)).rows).toEqual(tb);
  });

  it('a queued closed-period paycheck needs the password to get its number', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const [emp] = await t.db
      .insert(employees)
      .values({ companyId: t.ctx.companyId, firstName: 'Pat', lastName: 'Payee' })
      .returning();
    const entry = await postJournalEntry(t.ctx, {
      date: D('2026-01-15'),
      description: 'Paycheck',
      lines: [
        { accountId: t.acct['6500'], debit: '500.00' },
        { accountId: t.acct['2300'], credit: '100.00' },
        { accountId: t.acct['1000'], credit: '400.00' },
      ],
    });
    const [pc] = await t.db
      .insert(paychecks)
      .values({
        companyId: t.ctx.companyId,
        employeeId: emp.id,
        payDate: D('2026-01-15'),
        grossPay: '500.00',
        totalTaxes: '100.00',
        netPay: '400.00',
        postedEntryId: entry.id,
      })
      .returning();
    await queuePaychecks(t.ctx, [pc.id]);
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    const tb = (await trialBalance(t.ctx, AS_OF)).rows;

    await expect(markPrinted(t.ctx, { source: 'paycheck', id: pc.id, checkNumber: '7201' })).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
    const [still] = await t.db.select().from(paychecks).where(eq(paychecks.id, pc.id));
    expect(still.toPrint).toBe(true);
    expect(still.checkNumber ?? null).toBeNull();

    await markPrinted(over, { source: 'paycheck', id: pc.id, checkNumber: '7201' });
    const [printed] = await t.db.select().from(paychecks).where(eq(paychecks.id, pc.id));
    expect(printed.checkNumber).toBe('7201');
    expect(printed.toPrint).toBe(false);
    expect(await exceptionsFor(entry.id)).toBeGreaterThan(0);
    expect((await trialBalance(t.ctx, AS_OF)).rows).toEqual(tb);
  });
});
