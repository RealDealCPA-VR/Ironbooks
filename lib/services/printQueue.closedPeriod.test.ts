/**
 * P1 controls (fix round 1): Print Checks stamps a check number on the check (and its journal
 * entry reference). For a check dated on/before the closing date that is a change to a
 * closed-period transaction, so QB asks for the closing date password — and the exception is
 * listed on the Closing Date Exception report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { employees, expenses, paychecks } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { postJournalEntry } from './posting';
import { createVendor } from './vendors';
import { createExpense } from './expenses';
import { markPrinted, queuePaychecks } from './printQueue';
import { setClosingDate } from './company';
import { trialBalance } from './reports';
import { closingDateExceptionReport } from './accountant/auditReports';

let t: TestCompany;
let over: ServiceContext;
let vendorId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);

beforeAll(async () => {
  t = await makeTestCompany('p1-print-closed');
  over = { ...t.ctx, closingDateOverride: true };
  vendorId = (await createVendor(t.ctx, { displayName: 'Print Vendor' } as never)).id;
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

describe('Print Checks respects the closing date', () => {
  it('assigning a number to a queued closed-period check needs the password; open-period checks print normally', async () => {
    const closed = await createExpense(t.ctx, {
      vendorId,
      date: D('2026-01-10'),
      method: 'check',
      toPrint: true,
      paymentAccountId: t.acct['1000'],
      lines: [{ accountId: t.acct['6300'], amount: '12.00' }],
    });
    const open = await createExpense(t.ctx, {
      vendorId,
      date: D('2026-02-10'),
      method: 'check',
      toPrint: true,
      paymentAccountId: t.acct['1000'],
      lines: [{ accountId: t.acct['6300'], amount: '13.00' }],
    });
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    const tb = (await trialBalance(t.ctx, D('2026-12-31'))).rows;

    await expect(markPrinted(t.ctx, { source: 'expense', id: closed.id, checkNumber: '9001' })).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
    const [still] = await t.ctx.db.select().from(expenses).where(eq(expenses.id, closed.id));
    expect(still.toPrint).toBe(true);
    expect(still.reference ?? null).not.toBe('9001');

    await markPrinted(t.ctx, { source: 'expense', id: open.id, checkNumber: '9002' });

    await markPrinted(over, { source: 'expense', id: closed.id, checkNumber: '9001' });
    const [printed] = await t.ctx.db.select().from(expenses).where(eq(expenses.id, closed.id));
    expect(printed.toPrint).toBe(false);
    expect(printed.reference).toBe('9001');

    expect((await trialBalance(t.ctx, D('2026-12-31'))).rows).toEqual(tb);
    const rows = (await closingDateExceptionReport(t.ctx)).rows;
    expect(rows.some((r) => r.entryId === closed.postedEntryId)).toBe(true);
  });

  it('putting a closed-period paycheck in the print queue needs the password and is listed as an exception', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const [emp] = await t.ctx.db
      .insert(employees)
      .values({ companyId: t.ctx.companyId, firstName: 'Queue', lastName: 'Payee' })
      .returning();
    const entry = await postJournalEntry(t.ctx, {
      date: D('2026-01-15'),
      description: 'Paycheck',
      lines: [
        { accountId: t.acct['6500'], debit: '300.00' },
        { accountId: t.acct['2300'], credit: '50.00' },
        { accountId: t.acct['1000'], credit: '250.00' },
      ],
    });
    const [pc] = await t.ctx.db
      .insert(paychecks)
      .values({
        companyId: t.ctx.companyId,
        employeeId: emp.id,
        payDate: D('2026-01-15'),
        grossPay: '300.00',
        totalTaxes: '50.00',
        netPay: '250.00',
        postedEntryId: entry.id,
      })
      .returning();
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    const tb = (await trialBalance(t.ctx, D('2026-12-31'))).rows;

    await expect(queuePaychecks(t.ctx, [pc.id])).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    const [still] = await t.ctx.db.select().from(paychecks).where(eq(paychecks.id, pc.id));
    expect(still.toPrint).toBe(false);

    await queuePaychecks(over, [pc.id]);
    const [queued] = await t.ctx.db.select().from(paychecks).where(eq(paychecks.id, pc.id));
    expect(queued.toPrint).toBe(true);
    expect((await closingDateExceptionReport(t.ctx)).rows.some((r) => r.entryId === entry.id)).toBe(true);
    expect((await trialBalance(t.ctx, D('2026-12-31'))).rows).toEqual(tb);
  });
});
