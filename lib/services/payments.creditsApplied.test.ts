/**
 * Receive Payments answers `creditsApplied` (lib/services/payments.ts receivePayment, and an edit,
 * updatePayment): one total of the credits the save used (credit memos, earlier payments, General
 * Journal credits), as Pay Bills answers it. Applying a credit posts no new entry, so the cash amount alone would judge a $1
 * payment that applies a $150 credit at $1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { journalEntryLines } from '@/lib/db/schema';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createCreditMemo } from './creditMemos';
import { createManualEntry } from './journal';
import { receivePayment, updatePayment } from './payments';

let t: TestCompany;
let customerId: string;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const invoice = async (rate: string, date = '2026-03-01') =>
  createInvoice(t.ctx, { customerId, date: day(date), dueDate: day('2026-04-01'), lines: [{ description: 'Work', quantity: '1', rate }] });

beforeAll(async () => {
  t = await makeTestCompany('credits-applied');
  customerId = (await createCustomer(t.ctx, { displayName: 'Credit Customer' })).id;
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('creditsApplied', () => {
  it('a plain payment applies no credit', async () => {
    const inv = await invoice('80.00');
    const r = await receivePayment(t.ctx, {
      customerId,
      date: day('2026-03-05'),
      method: 'check',
      amount: '80.00',
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    });
    expect(r.creditsApplied).toBe('0.00');
    expect(r.payment.amount).toBe('80.00');
  });

  it('a $1 payment that applies a $150 credit memo answers the $150', async () => {
    const inv = await invoice('500.00');
    const memo = await createCreditMemo(t.ctx, {
      customerId,
      date: day('2026-03-02'),
      lines: [{ description: 'Return', quantity: 1, rate: 150, taxable: false }],
    });
    const r = await receivePayment(t.ctx, {
      customerId,
      date: day('2026-03-06'),
      method: 'check',
      amount: '1.00',
      applications: [{ invoiceId: inv.id, amountApplied: '1.00' }],
      credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '150' }],
    });
    expect(r.payment.amount).toBe('1.00');
    expect(r.creditsApplied).toBe('150.00');
  });

  it('only an earlier payment used (no new payment recorded) still answers the credit', async () => {
    const first = await invoice('100.00', '2026-06-01');
    const second = await invoice('50.00', '2026-06-02');
    const over = await receivePayment(t.ctx, {
      customerId,
      date: day('2026-06-05'),
      method: 'check',
      amount: '140',
      applications: [{ invoiceId: first.id, amountApplied: '100' }],
    });
    expect(over.creditsApplied).toBe('0.00');
    const r = await receivePayment(t.ctx, {
      customerId,
      date: day('2026-06-06'),
      method: 'cash',
      amount: '0',
      applications: [],
      paymentCredits: [{ paymentId: over.payment.id, invoiceId: second.id, amount: '40' }],
    });
    expect(r.entry).toBeNull();
    expect(r.creditsApplied).toBe('40.00');
  });

  it('General Journal credits, to an invoice and to a General Journal charge, count too', async () => {
    const ar = t.acct['1200'];
    const lineOf = async (entryId: string) =>
      (await t.db.select().from(journalEntryLines).where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, ar))))[0].id;
    const arCredit = async (amount: string) =>
      lineOf(
        (
          await createManualEntry(t.ctx, {
            date: day('2026-08-01'),
            description: 'Courtesy credit',
            lines: [
              { accountId: t.acct['6000'], debit: amount },
              { accountId: ar, credit: amount, entityType: 'customer', entityId: customerId },
            ],
          })
        ).id,
      );
    const toInvoice = await arCredit('30.00');
    const toCharge = await arCredit('20.00');
    const charge = await lineOf(
      (
        await createManualEntry(t.ctx, {
          date: day('2026-08-01'),
          description: 'Rebill freight',
          lines: [
            { accountId: ar, debit: '25.00', entityType: 'customer', entityId: customerId },
            { accountId: t.acct['4000'], credit: '25.00' },
          ],
        })
      ).id,
    );
    const inv = await invoice('40.00', '2026-08-01');
    const r = await receivePayment(t.ctx, {
      customerId,
      date: day('2026-08-05'),
      method: 'check',
      amount: '10.00',
      applications: [{ invoiceId: inv.id, amountApplied: '10.00' }],
      journalCredits: [{ journalLineId: toInvoice, invoiceId: inv.id, amount: '30.00' }],
      journalOffsets: [{ journalLineId: toCharge, chargeLineId: charge, amount: '20.00' }],
    });
    expect(r.payment.amount).toBe('10.00');
    expect(r.creditsApplied).toBe('50.00');

    // An edit answers it too (updatePayment). One that does not mention the General Journal offsets
    // keeps them, and they count: the edit applied them again.
    const edited = await updatePayment(t.ctx, r.payment.id, {
      customerId,
      date: day('2026-08-06'),
      method: 'check',
      amount: '10.00',
      applications: [{ invoiceId: inv.id, amountApplied: '10.00' }],
      journalCredits: [{ journalLineId: toInvoice, invoiceId: inv.id, amount: '30.00' }],
    });
    expect(edited.payment.amount).toBe('10.00');
    expect(edited.creditsApplied).toBe('50.00');
  });

  it('an edit to a $1 payment that applies a $150 credit memo answers the $150', async () => {
    const inv = await invoice('300.00', '2026-09-01');
    const memo = await createCreditMemo(t.ctx, {
      customerId,
      date: day('2026-09-02'),
      lines: [{ description: 'Return', quantity: 1, rate: 150, taxable: false }],
    });
    const base = { customerId, date: day('2026-09-05'), method: 'check' as const, amount: '1.00', applications: [{ invoiceId: inv.id, amountApplied: '1.00' }] };
    const first = await receivePayment(t.ctx, base);
    expect(first.creditsApplied).toBe('0.00');
    const edited = await updatePayment(t.ctx, first.payment.id, { ...base, credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '150' }] });
    expect(edited.payment.amount).toBe('1.00');
    expect(edited.creditsApplied).toBe('150.00');
    // Taking the credit off again: the edit applies none.
    const plain = await updatePayment(t.ctx, first.payment.id, base);
    expect(plain.creditsApplied).toBe('0.00');
  });
});
