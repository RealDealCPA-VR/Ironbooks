/**
 * C1 (gapsb): a received payment that is already in a bank deposit can still be edited when its
 * amount is unchanged — re-applied to different invoices, re-dated (not past the deposit date),
 * new reference / memo / method — as QuickBooks allows. Changing the amount (or customer,
 * currency, Undeposited Funds) is refused with a plain message unless the edit also takes the
 * payment out of the deposit. After every step the books stay tied: trial balance balanced,
 * A/R aging == A/R control, Undeposited Funds == what is still waiting to be deposited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, invoices, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { getPayment, receivePayment, updatePayment, voidPayment } from './payments';
import { createDeposit, getDeposit, listUndepositedPayments } from './deposits';
import { trialBalance } from './reports';
import { arAging } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-gapsb-deposited-payment');
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const AS_OF = new Date('2026-12-31T23:59:59Z');

let db: DB;
let ctx: ServiceContext;
let customerId: string;
const code: Record<string, string> = {};

async function balanceOf(accountCode: string): Promise<number> {
  const tb = await trialBalance(ctx, AS_OF);
  const row = tb.rows.find((r) => r.accountId === code[accountCode]);
  return row ? Math.round((Number(row.debit) - Number(row.credit)) * 100) / 100 : 0;
}

async function expectBooksTied() {
  const tb = await trialBalance(ctx, AS_OF);
  expect(tb.balanced).toBe(true);
  const arIds = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.subtype} = 'accounts_receivable'`))
    ).map((r) => r.id),
  );
  let ar = 0;
  for (const r of tb.rows) if (arIds.has(r.accountId)) ar += Number(r.debit) - Number(r.credit);
  expect(Number((await arAging(ctx, AS_OF)).totals.total)).toBeCloseTo(ar, 2);
  // Undeposited Funds holds exactly the payments still waiting to be deposited.
  const waiting = (await listUndepositedPayments(ctx)).reduce((s, p) => s + Number(p.amount), 0);
  expect(await balanceOf('1050')).toBeCloseTo(waiting, 2);
}

async function invoice(amount: string) {
  const inv = await createInvoice(ctx, {
    customerId,
    date: D('2026-03-01'),
    dueDate: D('2026-03-31'),
    lines: [{ accountId: code['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    overrideCreditLimit: true,
  } as Parameters<typeof createInvoice>[1]);
  return inv.id as string;
}

async function balanceDue(id: string) {
  const [row] = await db.select({ b: invoices.balanceDue }).from(invoices).where(eq(invoices.id, id));
  return Number(row.b);
}

async function pay(amount: string, invoiceId: string, date = '2026-03-05') {
  const { payment } = await receivePayment(ctx, {
    customerId,
    date: D(date),
    method: 'check',
    reference: 'CHK-1',
    amount,
    applications: [{ invoiceId, amountApplied: amount }],
  });
  return payment;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'c1@test.local', name: 'C1', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'C1 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) code[a.code] = a.id;
  customerId = (await createCustomer(ctx, { displayName: 'Deposit Customer' })).id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('C1: editing a deposited payment', () => {
  it('re-applies to a different invoice and changes date / reference / memo; deposit and ledger unchanged', async () => {
    const invA = await invoice('100.00');
    const invB = await invoice('100.00');
    const p1 = await pay('100.00', invA);
    const other = await pay('50.00', invB);
    const dep = await createDeposit(ctx, {
      depositAccountId: code['1000'],
      date: D('2026-03-10'),
      paymentIds: [p1.id, other.id],
    });
    expect(await balanceOf('1000')).toBeCloseTo(150, 2);
    await expectBooksTied();

    const detail = await getPayment(ctx, p1.id);
    expect(detail.deposit?.id).toBe(dep.id);

    const { payment } = await updatePayment(ctx, p1.id, {
      customerId,
      date: D('2026-03-04'),
      method: 'ach',
      reference: 'CHK-1-corrected',
      memo: 'Applied to the right invoice',
      amount: '100.00',
      applications: [{ invoiceId: invB, amountApplied: '50.00' }],
    });
    expect(payment.reference).toBe('CHK-1-corrected');
    expect(payment.memo).toBe('Applied to the right invoice');
    expect(payment.method).toBe('ach');
    expect(Number(payment.unapplied)).toBeCloseTo(50, 2);
    expect(await balanceDue(invA)).toBeCloseTo(100, 2);
    expect(await balanceDue(invB)).toBeCloseTo(0, 2);

    // The deposit is untouched: same total, same lines, bank and Undeposited Funds unchanged.
    const after = await getDeposit(ctx, dep.id);
    expect(after.voidedAt).toBeNull();
    expect(Number(after.total)).toBeCloseTo(150, 2);
    expect(after.lines.map((l) => l.paymentId).sort()).toEqual([p1.id, other.id].sort());
    expect(await balanceOf('1000')).toBeCloseTo(150, 2);
    expect(await balanceOf('1050')).toBeCloseTo(0, 2);
    expect((await getPayment(ctx, p1.id)).deposit?.id).toBe(dep.id);
    await expectBooksTied();
  });

  it('refuses an amount change with a plain message (offering to take it out of the deposit), nothing saved', async () => {
    const inv = await invoice('80.00');
    const p = await pay('80.00', inv);
    await createDeposit(ctx, { depositAccountId: code['1000'], date: D('2026-03-12'), paymentIds: [p.id] });
    const bankBefore = await balanceOf('1000');

    const err = await updatePayment(ctx, p.id, {
      customerId,
      date: D('2026-03-05'),
      method: 'check',
      amount: '70.00',
      applications: [{ invoiceId: inv, amountApplied: '70.00' }],
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'CONFLICT', details: { canRemoveFromDeposit: true } });
    expect(err.message).toMatch(/part of the bank deposit made on 2026-03-12/);
    expect(err.message).toMatch(/amount must stay 80\.00/);
    expect(err.message).toMatch(/Remove from deposit/);
    // fixit: the same way out as a Fix button (resend with removeFromDeposit).
    expect(err.fixes).toEqual([
      expect.objectContaining({ id: 'deposit-remove', kind: 'retry', patch: [{ op: 'set', path: 'removeFromDeposit', value: true }] }),
    ]);

    expect(Number((await getPayment(ctx, p.id)).amount)).toBeCloseTo(80, 2);
    expect(await balanceDue(inv)).toBeCloseTo(0, 2);
    expect(await balanceOf('1000')).toBeCloseTo(bankBefore, 2);
    await expectBooksTied();
  });

  it('refuses a date after the deposit, a different customer or moving it off Undeposited Funds', async () => {
    const inv = await invoice('60.00');
    const p = await pay('60.00', inv);
    await createDeposit(ctx, { depositAccountId: code['1000'], date: D('2026-03-15'), paymentIds: [p.id] });
    const base = {
      customerId,
      date: D('2026-03-05'),
      method: 'check' as const,
      amount: '60.00',
      applications: [{ invoiceId: inv, amountApplied: '60.00' }],
    };
    await expect(updatePayment(ctx, p.id, { ...base, date: D('2026-03-20') })).rejects.toThrow(
      /cannot be later than the deposit date/,
    );
    const otherCustomer = (await createCustomer(ctx, { displayName: 'Someone Else' })).id;
    await expect(
      updatePayment(ctx, p.id, { ...base, customerId: otherCustomer, applications: [] }),
    ).rejects.toThrow(/same customer/);
    await expect(updatePayment(ctx, p.id, { ...base, depositAccountId: code['1000'] })).rejects.toThrow(
      /Undeposited Funds/,
    );
    // Dated ON the deposit date is fine.
    await updatePayment(ctx, p.id, { ...base, date: D('2026-03-15') });
    await expectBooksTied();
  });

  it('an amount change with removeFromDeposit takes it out of the deposit, keeping the rest', async () => {
    const invA = await invoice('120.00');
    const invB = await invoice('30.00');
    const p = await pay('120.00', invA);
    const keep = await pay('30.00', invB);
    const dep = await createDeposit(ctx, {
      depositAccountId: code['1000'],
      date: D('2026-03-18'),
      paymentIds: [p.id, keep.id],
    });
    const bankBefore = await balanceOf('1000');

    await updatePayment(ctx, p.id, {
      customerId,
      date: D('2026-03-05'),
      method: 'check',
      amount: '100.00',
      applications: [{ invoiceId: invA, amountApplied: '100.00' }],
      removeFromDeposit: true,
    });
    const after = await getDeposit(ctx, dep.id);
    expect(after.voidedAt).toBeNull();
    expect(Number(after.total)).toBeCloseTo(30, 2);
    expect(after.lines.map((l) => l.paymentId)).toEqual([keep.id]);
    expect(await balanceOf('1000')).toBeCloseTo(bankBefore - 120, 2);
    expect((await getPayment(ctx, p.id)).deposit).toBeNull();
    expect((await listUndepositedPayments(ctx)).map((x) => x.id)).toContain(p.id);
    expect(await balanceDue(invA)).toBeCloseTo(20, 2);
    await expectBooksTied();
  });

  it('removeFromDeposit on a deposit holding only this payment voids that deposit', async () => {
    const inv = await invoice('45.00');
    const p = await pay('45.00', inv);
    const dep = await createDeposit(ctx, { depositAccountId: code['1000'], date: D('2026-03-19'), paymentIds: [p.id] });
    await updatePayment(ctx, p.id, {
      customerId,
      date: D('2026-03-05'),
      method: 'check',
      amount: '40.00',
      applications: [{ invoiceId: inv, amountApplied: '40.00' }],
      removeFromDeposit: true,
    });
    expect((await getDeposit(ctx, dep.id)).voidedAt).not.toBeNull();
    expect(await balanceDue(inv)).toBeCloseTo(5, 2);
    await expectBooksTied();
  });

  it('voiding a deposited payment is still refused', async () => {
    const inv = await invoice('25.00');
    const p = await pay('25.00', inv);
    await createDeposit(ctx, { depositAccountId: code['1000'], date: D('2026-03-21'), paymentIds: [p.id] });
    await expect(voidPayment(ctx, p.id)).rejects.toThrow(/included in a deposit and cannot be voided/);
    await expectBooksTied();
  });
});
