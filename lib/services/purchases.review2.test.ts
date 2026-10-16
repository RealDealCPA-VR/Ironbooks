/**
 * Regression tests from review round 2 (purchases / A/P).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  vendors,
  employees,
  journalEntries,
  journalEntryLines,
  purchaseOrders,
  purchaseOrderLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { voidBill } from './bills';
import { createExpense, updateExpense } from './expenses';
import { createReport, submitReport, approveAndReimburse } from './expenseReports';
import { createAsset, postDepreciation } from './fixedAssets';
import { createPurchaseOrder, convertToBill } from './purchaseOrders';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-purchases');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let vendorId: string;
let vendor2Id: string;

describe('review2 purchases', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r2p@test.local', name: 'R2P', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'R2P Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1500', 'Equipment', 'asset', 'fixed_assets'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['3000', 'Equity', 'equity', 'owners_equity'],
      ['5000', 'Supplies', 'expense', 'operating_expenses'],
      ['6800', 'Depreciation Expense', 'expense', 'operating_expenses'],
      ['1590', 'Accumulated Depreciation', 'asset', 'fixed_assets'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'V1' }).returning();
    vendorId = v.id;
    const [v2] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'V2' }).returning();
    vendor2Id = v2.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('expense report: two concurrent approve requests reimburse the employee only once', async () => {
    const [emp] = await db
      .insert(employees)
      .values({ companyId: ctx.companyId, firstName: 'E', lastName: 'One' })
      .returning();
    const report = await createReport(ctx, {
      employeeId: emp.id,
      title: 'Trip',
      lines: [{ accountId: acct['5000'], amount: '100.00' }],
    });
    const submits = await Promise.allSettled([submitReport(ctx, report.id), submitReport(ctx, report.id)]);
    expect(submits.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const results = await Promise.allSettled([approveAndReimburse(ctx, report.id), approveAndReimburse(ctx, report.id)]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const posted = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `expense_report:${report.id}`)));
    expect(posted.length).toBe(1);
    expect(ok).toBe(1);
  });

  it('fixed asset: usefulLifeMonths postings depreciate the full base (no leftover cent)', async () => {
    const asset = await createAsset(ctx, {
      name: 'Laptop',
      cost: '1000.00',
      salvageValue: '0',
      usefulLifeMonths: 3,
      placedInService: new Date('2025-01-01'),
    } as never);
    for (let m = 1; m <= 3; m++) {
      await postDepreciation(ctx, { assetId: asset.id, date: new Date(Date.UTC(2025, m, 1)) });
    }
    // After the asset's whole useful life it must be fully depreciated (schedule's last period = 333.34).
    await expect(
      postDepreciation(ctx, { assetId: asset.id, date: new Date(Date.UTC(2025, 4, 1)) }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('voiding a bill converted from a PO gives the PO its unbilled quantity back', async () => {
    const po = await createPurchaseOrder(ctx, {
      vendorId,
      date: new Date('2025-04-01'),
      lines: [{ accountId: acct['5000'], quantity: 2, rate: 50 }],
    });
    const bill = await convertToBill(ctx, po.id);
    await voidBill(ctx, bill.id);
    const [poRow] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    const [line] = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    expect(Number(line.quantityBilled)).toBe(0);
    expect(poRow.status).not.toBe('closed');
  });

  it('editing only the payee vendor of a check with an A/P line moves the A/P line to the new vendor', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: new Date('2025-05-01'),
      method: 'check',
      reference: '5001',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['2000'], amount: '40.00' }],
    });
    const updated = await updateExpense(ctx, exp.id, {
      vendorId: vendor2Id,
      date: new Date('2025-05-01'),
      method: 'check',
      reference: '5001',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['2000'], amount: '40.00' }],
    });
    expect(updated.vendorId).toBe(vendor2Id);
    const lines = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, updated.postedEntryId!), eq(journalEntryLines.accountId, acct['2000'])));
    expect(lines).toHaveLength(1);
    expect(lines[0].entityId).toBe(vendor2Id);
  });
});
