/**
 * Regression tests from the purchases / A/P review:
 *  - unapplyFromBill only reverses what a credit applied to that bill (refunds are not applications).
 *  - 1099 reports skip voided checks.
 *  - 1099 reports count cash paid, not early-payment discounts taken.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createBill } from './bills';
import { createExpense, voidExpense } from './expenses';
import { vendor1099Report, vendor1099Worksheet } from './statements';
import { payBills } from './billPayments';
import { createVendorCredit, applyToBill, unapplyFromBill, refundVendorCredit } from './vendorCredits';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-purchases-review');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let vendorId: string;

describe('review purchases', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rp@test.local', name: 'RP', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'RP Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['5000', 'Supplies', 'expense', 'operating_expenses'],
      ['4900', 'Discounts Taken', 'revenue', 'other_income'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'V1' }).returning();
    vendorId = v.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('unapply refuses a credit that was refunded (never applied to this bill)', async () => {
    const d = new Date('2025-03-01');
    const creditA = await createVendorCredit(ctx, { vendorId, date: d, lines: [{ accountId: acct['5000'], amount: '100.00' }] });
    await refundVendorCredit(ctx, { vendorCreditId: creditA.id, bankAccountId: acct['1000'], amount: '100.00', date: d });

    const creditB = await createVendorCredit(ctx, { vendorId, date: d, lines: [{ accountId: acct['5000'], amount: '50.00' }] });
    const billY = await createBill(ctx, { vendorId, date: d, lines: [{ accountId: acct['5000'], amount: '200.00' }] });
    await applyToBill(ctx, { vendorCreditId: creditB.id, billId: billY.id, amount: '50.00', date: d });

    // Credit A was refunded in full, never applied to bill Y: unapplying it from Y must be refused.
    await expect(
      unapplyFromBill(ctx, { vendorCreditId: creditA.id, billId: billY.id, amount: '50.00', date: d }),
    ).rejects.toThrow(/applied to this bill/);
    // The credit that really was applied can still come off.
    const r = await unapplyFromBill(ctx, { vendorCreditId: creditB.id, billId: billY.id, amount: '50.00', date: d });
    expect(r.bill.balanceDue).toBe('200.00');
    expect(r.credit.unapplied).toBe('50.00');
    // ...but not twice.
    await expect(
      unapplyFromBill(ctx, { vendorCreditId: creditB.id, billId: billY.id, amount: '0.01', date: d }),
    ).rejects.toThrow();
  });

  it('1099 report excludes voided checks', async () => {
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Contractor', is1099: true }).returning();
    const exp = await createExpense(ctx, {
      vendorId: v.id, date: new Date('2025-05-01'), method: 'check', reference: '501',
      paymentAccountId: acct['1000'], lines: [{ accountId: acct['5000'], amount: '700.00' }],
    } as never);
    await voidExpense(ctx, exp.id);
    const rows = await vendor1099Report(ctx, { year: 2025 });
    expect(rows.find((r) => r.vendorId === v.id)).toBeUndefined();
  });

  it('1099 totals count cash paid, not discounts taken', async () => {
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Consultant', is1099: true }).returning();
    const d = new Date('2025-06-01');
    const b1 = await createBill(ctx, { vendorId: v.id, date: d, lines: [{ accountId: acct['5000'], amount: '1000.00' }] });
    const b2 = await createBill(ctx, { vendorId: v.id, date: d, lines: [{ accountId: acct['5000'], amount: '300.00' }] });
    await payBills(ctx, {
      vendorId: v.id, date: d, method: 'check', reference: '777',
      paymentAccountId: acct['1000'], discountAccountId: acct['4900'],
      applications: [
        { billId: b1.id, amountApplied: '980.00', discountTaken: '20.00' },
        { billId: b2.id, amountApplied: '300.00' },
      ],
    });
    const rows = await vendor1099Report(ctx, { year: 2025 });
    expect(rows.find((r) => r.vendorId === v.id)?.total).toBe('1280.00');
    const ws = await vendor1099Worksheet(ctx, { year: 2025 });
    const row = ws.rows.find((r) => r.vendorId === v.id);
    expect(row?.nec1).toBe('1280.00');
    expect(row?.total).toBe('1280.00');
  });
});
