/**
 * Review round 5 — accountant tools (each test failed before its fix):
 *  A  Reclassify Transactions changes the source document's rows, so it must move the document's
 *     version too: a bill / invoice / check someone had open before the reclassify is then
 *     refused as stale ("This record was changed by …") instead of silently re-posting the old
 *     account when it is saved.
 *  B  Fix Incorrectly Recorded Sales Tax: a double-submitted "count as a tax payment" posts the
 *     correcting entry once (the "already moved" check runs inside the transaction).
 *  C  Client Data Review's "Apply" fixes apply customer payments / credits and bill credits: they
 *     need the Customers / Vendors modify right like Receive Payments / Pay Bills (the route only
 *     guarantees Accounting).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, like } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bills, expenses, invoices, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createInvoice } from '../invoices';
import { createBill } from '../bills';
import { createExpense } from '../expenses';
import { createTaxAgency } from '../salesTax';
import { assertCurrentVersion, currentVersion } from '../concurrency';
import { trialBalance } from '../reports';
import { reclassifyLines } from './reclassify';
import { findMisrecordedSalesTax, reclassifySalesTaxPayment } from './salesTaxTools';
import { autoApplyCustomerCredit, autoApplyVendorCredit } from './clientDataReview';
import { receivePayment } from '../payments';
import { createVendorCredit } from '../vendorCredits';
import { paymentsReceived } from '@/lib/db/schema';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-accountant');
const D = (s: string) => new Date(`${s}T12:00:00Z`);

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;

async function lineOn(table: typeof bills | typeof invoices | typeof expenses, id: string, accountId: string) {
  const [row] = await db.select({ e: table.postedEntryId }).from(table).where(eq(table.id, id));
  const lines = await db
    .select()
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.journalEntryId, row.e!), eq(journalEntryLines.accountId, accountId)));
  return lines[0];
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-acct@test.local', name: 'Accountant', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review5 Accountant Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  acct.e1 = (await createAccount(ctx, { code: '6810', name: 'R5 Supplies', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct.e2 = (await createAccount(ctx, { code: '6820', name: 'R5 Repairs', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct.e3 = (await createAccount(ctx, { code: '6830', name: 'R5 Taxes & Licenses', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct.i1 = (await createAccount(ctx, { code: '4810', name: 'R5 Consulting', type: 'revenue' as never, subtype: 'service_revenue' })).id;
  acct.i2 = (await createAccount(ctx, { code: '4820', name: 'R5 Other Sales', type: 'revenue' as never, subtype: 'sales' })).id;
  customerId = (await createCustomer(ctx, { displayName: 'R5 Customer' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'R5 Vendor' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('A: reclassify makes an open copy of the source document stale', () => {
  it('bill', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: D('2026-03-02'),
      lines: [{ accountId: acct.e1, amount: '120.00', description: 'Paper' }],
    });
    const opened = await currentVersion(ctx, 'bill', bill.id);
    const line = await lineOn(bills, bill.id, acct.e1);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct.e2 });
    await expect(assertCurrentVersion(ctx, 'bill', bill.id, opened)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('invoice', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-03-03'),
      lines: [{ description: 'Work', quantity: 1, rate: '300.00', accountId: acct.i1 }],
    });
    const opened = await currentVersion(ctx, 'invoice', inv.id);
    const line = await lineOn(invoices, inv.id, acct.i1);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct.i2 });
    await expect(assertCurrentVersion(ctx, 'invoice', inv.id, opened)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('check', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: D('2026-03-04'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct.e1, amount: '45.00' }],
    });
    const opened = await currentVersion(ctx, 'expense', exp.id);
    const line = await lineOn(expenses, exp.id, acct.e1);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct.e2 });
    await expect(assertCurrentVersion(ctx, 'expense', exp.id, opened)).rejects.toMatchObject({ code: 'CONFLICT' });
    const tb = await trialBalance(ctx);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});

describe('B: Fix Incorrectly Recorded Sales Tax', () => {
  it('a double-submitted "count as a tax payment" posts one correcting entry', async () => {
    const agency = (await createTaxAgency(ctx, { name: 'R5 State Revenue Dept' })).id;
    await createExpense(ctx, {
      payeeName: 'R5 State Revenue Dept',
      date: D('2026-04-15'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct.e3, amount: '210.00', description: 'Q1 sales tax' }],
    });
    const issue = (await findMisrecordedSalesTax(ctx)).find((i) => i.issue === 'expense_payment' && i.amount === '210.00');
    expect(issue).toBeDefined();
    await Promise.allSettled([
      reclassifySalesTaxPayment(ctx, { lineId: issue!.lineId, agencyId: agency }),
      reclassifySalesTaxPayment(ctx, { lineId: issue!.lineId, agencyId: agency }),
    ]);
    const fixes = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          like(journalEntries.reference, `fix-line:${issue!.lineId}`),
        ),
      );
    expect(fixes).toHaveLength(1);
  });
});

function accessWith(grant: PermissionGrant): EffectiveAccess {
  return {
    roleKeys: ['custom'],
    permissions: normalizeGrant(grant),
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
}

describe('C: Client Data Review is no side door around Customers / Vendors', () => {
  it('applying a customer payment needs Customers: modify; a bill credit needs Vendors: modify', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R5 Review Customer' })).id;
    await createInvoice(ctx, {
      customerId: cust,
      date: D('2026-05-01'),
      lines: [{ description: 'Work', quantity: 1, rate: '100.00', accountId: acct.i1 }],
    });
    const pay = await receivePayment(ctx, { customerId: cust, date: D('2026-05-03'), method: 'check', amount: '100.00', applications: [] });
    const payId = (pay as { id?: string; payment?: { id: string } }).payment?.id ?? (pay as { id: string }).id;
    const vend = (await createVendor(ctx, { displayName: 'R5 Review Vendor' })).id;
    await createBill(ctx, { vendorId: vend, date: D('2026-05-01'), lines: [{ accountId: acct.e1, amount: '60.00' }] });
    const credit = await createVendorCredit(ctx, { vendorId: vend, date: D('2026-05-02'), lines: [{ accountId: acct.e1, amount: '20.00' }] });

    // Accounting: full, but nothing in Customers / Vendors.
    const accountantOnly = { ...ctx, access: accessWith({ accounting: ['full'] }) };
    await expect(autoApplyCustomerCredit(accountantOnly, { refType: 'payment', refId: payId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(autoApplyVendorCredit(accountantOnly, { refId: credit.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [p] = await db.select({ unapplied: paymentsReceived.unapplied }).from(paymentsReceived).where(eq(paymentsReceived.id, payId));
    expect(p.unapplied).toBe('100.00');

    // With the area rights it works.
    const full = { ...ctx, access: accessWith({ accounting: ['full'], customers: ['full'], vendors: ['full'] }) };
    expect((await autoApplyCustomerCredit(full, { refType: 'payment', refId: payId })).applied).toBe('100.00');
    expect((await autoApplyVendorCredit(full, { refId: credit.id })).applied).toBe('20.00');
  });
});
