/**
 * Memorized Transaction List depth (B17): how-often modes (automatic / remind / never), number
 * remaining, days in advance, groups, edit/delete, more document types (check, transfer,
 * deposit, purchase order, sales receipt, credit memo), new frequencies, failure isolation —
 * and the books stay balanced throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { deposits, purchaseOrders, recurringTemplates, transfers } from '@/lib/db/schema';
import { trialBalance } from './reports';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import {
  advanceDate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  projectOccurrences,
  runDue,
  runGroup,
  runTemplateNow,
  updateTemplate,
} from './recurring';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
let customerId: string;
let vendorId: string;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function balanced() {
  const tb = await trialBalance(t.ctx);
  expect(tb.balanced).toBe(true);
}

describe('Memorized transactions (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('memorized');
    customerId = (await createCustomer(t.ctx, { displayName: 'Memo Customer' })).id;
    vendorId = (await createVendor(t.ctx, { displayName: 'Memo Vendor' })).id;
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('frequencies advance like QB (calendar days of UTC-midnight dates, month-end clamped)', () => {
    // Stored dates are UTC midnight, so the schedule works on UTC calendar fields.
    const local = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
    const ymd = (d: Date | null) => (d ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] : null);
    expect(ymd(advanceDate(local(2026, 1, 10), 'biweekly'))).toEqual([2026, 1, 24]);
    expect(ymd(advanceDate(local(2026, 1, 10), 'every_four_weeks'))).toEqual([2026, 2, 7]);
    expect(ymd(advanceDate(local(2026, 1, 1), 'semiannually'))).toEqual([2026, 7, 1]);
    expect(ymd(advanceDate(local(2026, 1, 1), 'bimonthly'))).toEqual([2026, 3, 1]);
    expect(ymd(advanceDate(local(2026, 1, 31), 'monthly'))).toEqual([2026, 2, 28]);
    expect(ymd(advanceDate(local(2028, 2, 29), 'yearly'))).toEqual([2029, 2, 28]);
    expect(ymd(advanceDate(local(2026, 8, 31), 'quarterly'))).toEqual([2026, 11, 30]);
    expect(advanceDate(local(2026, 1, 1), 'never')).toBeNull();
    const sm1 = advanceDate(local(2026, 1, 1), 'semimonthly')!;
    expect([sm1.getUTCMonth(), sm1.getUTCDate()]).toEqual([0, 16]);
    const sm2 = advanceDate(sm1, 'semimonthly')!;
    expect([sm2.getUTCMonth(), sm2.getUTCDate()]).toEqual([1, 1]);
    expect(
      projectOccurrences(local(2026, 1, 1), 'monthly', local(2026, 2, 15), local(2026, 5, 15)).map(ymd),
    ).toEqual([
      [2026, 3, 1],
      [2026, 4, 1],
      [2026, 5, 1],
    ]);
  });

  it('automatic entry honors number remaining and deactivates at zero', async () => {
    const tpl = await createTemplate(t.ctx, {
      name: 'Rent check',
      docType: 'check',
      frequency: 'monthly',
      nextRunDate: day('2026-01-01'),
      mode: 'automatic',
      remaining: 2,
      template: {
        payeeName: 'Landlord',
        method: 'cash', // forced to 'check' by the check docType
        paymentAccountId: t.acct['1000'],
        lines: [{ accountId: t.acct['6400'], amount: '1000.00' }],
      },
    });
    const r1 = await runDue(t.ctx, day('2026-01-02'));
    expect(r1.generated.map((g) => g.templateId)).toContain(tpl.id);
    expect((await getTemplate(t.ctx, tpl.id)).remaining).toBe(1);
    await runDue(t.ctx, day('2026-02-02'));
    const done = await getTemplate(t.ctx, tpl.id);
    expect(done.remaining).toBe(0);
    expect(done.isActive).toBe(false);
    expect(done.lastRunAt).toBeTruthy();
    const r3 = await runDue(t.ctx, day('2026-03-02'));
    expect(r3.generated.some((g) => g.templateId === tpl.id)).toBe(false);
    await expect(runTemplateNow(t.ctx, tpl.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await balanced();
  });

  it('days in advance enters before the scheduled date, dated on the scheduled date', async () => {
    const tpl = await createTemplate(t.ctx, {
      name: 'Savings sweep',
      docType: 'transfer',
      frequency: 'monthly',
      nextRunDate: day('2026-04-10'),
      daysInAdvance: 5,
      template: { fromAccountId: t.acct['1000'], toAccountId: t.acct['1010'], amount: '50.00', memo: 'sweep' },
    });
    expect((await runDue(t.ctx, day('2026-04-04'))).generated.some((g) => g.templateId === tpl.id)).toBe(false);
    const r = await runDue(t.ctx, day('2026-04-06'));
    const gen = r.generated.find((g) => g.templateId === tpl.id)!;
    expect(gen).toBeTruthy();
    const [tr] = await t.db.select().from(transfers).where(eq(transfers.id, gen.docId));
    expect(tr.date.toISOString().slice(0, 10)).toBe('2026-04-10');
    expect((await getTemplate(t.ctx, tpl.id)).nextRunDate?.toISOString().slice(0, 10)).toBe('2026-05-10');
    await balanced();
  });

  it('remind and never modes do not post; remind shows up as a reminder', async () => {
    const remind = await createTemplate(t.ctx, {
      name: 'Utilities bill',
      docType: 'bill',
      frequency: 'monthly',
      nextRunDate: day('2026-01-01'),
      mode: 'remind',
      template: { vendorId, lines: [{ accountId: t.acct['6600'], amount: '75.00' }] },
    });
    const never = await createTemplate(t.ctx, {
      name: 'Year-end adjust',
      docType: 'journal_entry',
      frequency: 'yearly',
      nextRunDate: day('2026-01-01'),
      mode: 'never',
      template: {
        description: 'Adjust',
        lines: [
          { accountId: t.acct['6200'], debit: '10.00' },
          { accountId: t.acct['1000'], credit: '10.00' },
        ],
      },
    });
    const r = await runDue(t.ctx, day('2026-01-05'));
    expect(r.reminders.map((x) => x.templateId)).toContain(remind.id);
    expect(r.generated.some((g) => g.templateId === remind.id || g.templateId === never.id)).toBe(false);
    expect(r.reminders.some((x) => x.templateId === never.id)).toBe(false);
    // Legacy flag kept in sync for older readers.
    expect(((await getTemplate(t.ctx, remind.id)).template as Record<string, { autoEnter: boolean }>).__options.autoEnter).toBe(false);
    // Entering it manually works for both.
    await runTemplateNow(t.ctx, remind.id, day('2026-01-05'));
    await runTemplateNow(t.ctx, never.id, day('2026-01-05'));
    await balanced();
  });

  it('edits the schedule and options, then deletes', async () => {
    const tpl = await createTemplate(t.ctx, {
      name: 'Draft',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: day('2027-01-01'),
      template: { customerId, lines: [{ description: 'Retainer', quantity: '1', rate: '100.00' }] },
    });
    const upd = await updateTemplate(t.ctx, tpl.id, {
      name: 'Retainer',
      frequency: 'quarterly',
      mode: 'remind',
      groupName: 'Month-end',
      remaining: 4,
      daysInAdvance: 3,
    });
    expect(upd).toMatchObject({ name: 'Retainer', frequency: 'quarterly', mode: 'remind', groupName: 'Month-end', remaining: 4, daysInAdvance: 3 });
    await expect(updateTemplate(t.ctx, tpl.id, { remaining: -1 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateTemplate(t.ctx, tpl.id, { daysInAdvance: 400 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await deleteTemplate(t.ctx, tpl.id);
    await expect(getTemplate(t.ctx, tpl.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enters a whole memorized group, including sales receipts, credit memos, deposits and P.O.s', async () => {
    const common = { frequency: 'monthly' as const, nextRunDate: day('2027-06-01'), groupName: 'Monthly batch', mode: 'never' as const };
    await createTemplate(t.ctx, {
      ...common,
      name: 'Counter sale',
      docType: 'sales_receipt',
      template: { customerId, lines: [{ description: 'Walk-in', quantity: '1', rate: '20.00' }] },
    });
    await createTemplate(t.ctx, {
      ...common,
      name: 'Loyalty credit',
      docType: 'credit_memo',
      template: { customerId, lines: [{ description: 'Credit', quantity: '1', rate: '5.00' }] },
    });
    await createTemplate(t.ctx, {
      ...common,
      name: 'Owner contribution',
      docType: 'deposit',
      template: {
        depositAccountId: t.acct['1000'],
        paymentIds: ['00000000-0000-0000-0000-000000000000'], // never re-deposited
        extraLines: [{ accountId: t.acct['3000'], amount: '200.00', description: 'Owner money' }],
      },
    });
    await createTemplate(t.ctx, {
      ...common,
      name: 'Supplies P.O.',
      docType: 'purchase_order',
      template: {
        vendorId,
        date: '2027-01-01',
        expectedDate: '2027-01-15',
        lines: [{ accountId: t.acct['6300'], description: 'Paper', quantity: '2', rate: '12.50' }],
      },
    });
    const res = await runGroup(t.ctx, 'Monthly batch');
    expect(res.failed).toEqual([]);
    expect(res.generated).toHaveLength(4);
    const dep = res.generated.find((g) => g.docType === 'deposit')!;
    const [d] = await t.db.select().from(deposits).where(eq(deposits.id, dep.docId));
    expect(d.total).toBe('200.00');
    const poGen = res.generated.find((g) => g.docType === 'purchase_order')!;
    const [po] = await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poGen.docId));
    // expected date keeps its 14-day offset from the (new) document date
    expect(Math.round((po.expectedDate!.getTime() - po.date.getTime()) / 86_400_000)).toBe(14);
    await expect(runGroup(t.ctx, 'No such group')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await balanced();
  });

  it('a template that cannot post is reported and does not stop the others', async () => {
    const bad = await createTemplate(t.ctx, {
      name: 'Broken bill',
      docType: 'bill',
      frequency: 'monthly',
      nextRunDate: day('2027-09-01'),
      template: { vendorId, lines: [{ accountId: t.acct['6600'], amount: '-5.00' }] },
    });
    const good = await createTemplate(t.ctx, {
      name: 'Fine transfer',
      docType: 'transfer',
      frequency: 'monthly',
      nextRunDate: day('2027-09-01'),
      template: { fromAccountId: t.acct['1000'], toAccountId: t.acct['1010'], amount: '1.00' },
    });
    const r = await runDue(t.ctx, day('2027-09-02'));
    expect(r.failed.map((f) => f.templateId)).toContain(bad.id);
    expect(r.generated.map((g) => g.templateId)).toContain(good.id);
    const [stillDue] = await t.db.select().from(recurringTemplates).where(eq(recurringTemplates.id, bad.id));
    expect(stillDue.nextRunDate?.toISOString().slice(0, 10)).toBe('2027-09-01');
    await deleteTemplate(t.ctx, bad.id);
    await balanced();
  });
});
