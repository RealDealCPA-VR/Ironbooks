/**
 * Team ledger fix (P0): Reclassify must survive re-saving the source document.
 *
 * Original bug: reclassify.ts only re-pointed the document rows when an entry's WHOLE slice on the
 * old account moved, had no deposit or bill-credit branch, and ignored item lines — so opening the
 * deposit / vendor credit / bill (partial move) / invoice (item line) and saving it again, even
 * with only the memo changed, silently re-posted the OLD account.
 *
 * For every document type: reclassify, then edit only the memo and re-save the document from its
 * own rows (as the edit form does) → the reclassified account (or class) stays, and the books
 * stay balanced. Cases that can't be kept in the document are refused with a plain message.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  billLines,
  bills,
  creditMemoLines,
  creditMemos,
  depositLines,
  deposits,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  journalEntryLines,
  salesReceiptLines,
  salesReceipts,
  users,
  vendorCreditLines,
  vendorCredits,
} from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createClass } from '../dimensions';
import { createItem } from '../items';
import { createInvoice, updateInvoice } from '../invoices';
import { createSalesReceipt, updateSalesReceipt } from '../salesReceipts';
import { createCreditMemo, updateCreditMemo } from '../creditMemos';
import { createBill, updateBill } from '../bills';
import { createExpense, updateExpense } from '../expenses';
import { createVendorCredit, updateVendorCredit } from '../vendorCredits';
import { createDeposit, updateDeposit } from '../deposits';
import { trialBalance } from '../reports';
import { reclassifyLines } from './reclassify';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reclassify-durable');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);

async function postedEntryOf(table: { id: unknown; postedEntryId: unknown }, id: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [row] = await db.select({ e: (table as any).postedEntryId }).from(table as any).where(eq((table as any).id, id));
  return row.e as string;
}

async function entryLines(entryId: string) {
  return db
    .select()
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entryId))
    .orderBy(asc(journalEntryLines.createdAt));
}

async function lineOn(entryId: string, accountId: string) {
  return (await entryLines(entryId)).filter((l) => l.accountId === accountId);
}

async function expectBalanced() {
  const tb = await trialBalance(ctx);
  expect(tb.totalDebit).toBe(tb.totalCredit);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'reclass-durable@test.local', name: 'Reclass', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Reclassify Durable Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  for (const a of all) acct[a.code] = a.id;
  acct['4100'] ??= (await createAccount(ctx, { code: '4100', name: 'Consulting Income', type: 'revenue' as never, subtype: 'service_revenue' })).id;
  acct['4200'] = (await createAccount(ctx, { code: '4200', name: 'Other Sales', type: 'revenue' as never, subtype: 'sales' })).id;
  acct['6300'] ??= (await createAccount(ctx, { code: '6300', name: 'Supplies', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct['6400'] ??= (await createAccount(ctx, { code: '6400', name: 'Repairs', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct['3910'] = (await createAccount(ctx, { code: '3910', name: 'Owner Contributions', type: 'equity' as never, subtype: 'owners_equity' })).id;
  acct['3960'] = (await createAccount(ctx, { code: '3960', name: 'Owner Loans', type: 'equity' as never, subtype: 'owners_equity' })).id;
  customerId = (await createCustomer(ctx, { displayName: 'Reclass Customer' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'Reclass Vendor' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('reclassify survives re-saving the source document', () => {
  it('invoice: reclassify the income line, edit only the memo → stays on the new account', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-03-02'),
      memo: 'original',
      lines: [{ description: 'Work', quantity: 1, rate: '250.00', accountId: acct['4000'] }],
    });
    const entryId = await postedEntryOf(invoices, inv.id);
    const [income] = await lineOn(entryId, acct['4000']);
    await reclassifyLines(ctx, { lineIds: [income.id], newAccountId: acct['4100'] });

    const rows = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    await updateInvoice(ctx, inv.id, {
      customerId,
      date: D('2026-03-02'),
      memo: 'memo changed',
      lines: rows.map((r) => ({ itemId: r.itemId, accountId: r.accountId, description: r.description, quantity: r.quantity, rate: r.rate, taxable: r.taxable, classId: r.classId })),
    });
    const [after] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(after.memo).toBe('memo changed');
    expect(await lineOn(after.postedEntryId!, acct['4100'])).toHaveLength(1);
    expect(await lineOn(after.postedEntryId!, acct['4000'])).toHaveLength(0);
    await expectBalanced();
  });

  it('sales receipt: same', async () => {
    const sr = await createSalesReceipt(ctx, {
      customerId,
      date: D('2026-03-03'),
      depositAccountId: acct['1000'],
      lines: [{ description: 'Counter sale', quantity: 1, rate: '80.00', accountId: acct['4000'] }],
    });
    const entryId = await postedEntryOf(salesReceipts, sr.id);
    const [income] = await lineOn(entryId, acct['4000']);
    await reclassifyLines(ctx, { lineIds: [income.id], newAccountId: acct['4200'] });
    const rows = await db.select().from(salesReceiptLines).where(eq(salesReceiptLines.salesReceiptId, sr.id));
    await updateSalesReceipt(ctx, sr.id, {
      customerId,
      date: D('2026-03-03'),
      depositAccountId: acct['1000'],
      memo: 'memo changed',
      lines: rows.map((r) => ({ itemId: r.itemId, accountId: r.accountId, description: r.description, quantity: r.quantity, rate: r.rate, taxable: r.taxable })),
    });
    const [after] = await db.select().from(salesReceipts).where(eq(salesReceipts.id, sr.id));
    expect(await lineOn(after.postedEntryId!, acct['4200'])).toHaveLength(1);
    expect(await lineOn(after.postedEntryId!, acct['4000'])).toHaveLength(0);
    await expectBalanced();
  });

  it('credit memo: same', async () => {
    const cm = await createCreditMemo(ctx, {
      customerId,
      date: D('2026-03-04'),
      lines: [{ description: 'Return', quantity: 1, rate: '40.00', accountId: acct['4000'] }],
    });
    const entryId = await postedEntryOf(creditMemos, cm.id);
    const [income] = await lineOn(entryId, acct['4000']);
    await reclassifyLines(ctx, { lineIds: [income.id], newAccountId: acct['4200'] });
    const rows = await db.select().from(creditMemoLines).where(eq(creditMemoLines.creditMemoId, cm.id));
    await updateCreditMemo(ctx, cm.id, {
      customerId,
      date: D('2026-03-04'),
      memo: 'memo changed',
      lines: rows.map((r) => ({ itemId: r.itemId, accountId: r.accountId, description: r.description, quantity: r.quantity, rate: r.rate, taxable: r.taxable })),
    });
    const [after] = await db.select().from(creditMemos).where(eq(creditMemos.id, cm.id));
    expect(await lineOn(after.postedEntryId!, acct['4200'])).toHaveLength(1);
    expect(await lineOn(after.postedEntryId!, acct['4000'])).toHaveLength(0);
    await expectBalanced();
  });

  it('bill: a PARTIAL move (one of two lines on the same account) is kept', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: D('2026-03-05'),
      billNumber: 'RC-1',
      lines: [
        { accountId: acct['6000'], amount: '70.00', description: 'Paper' },
        { accountId: acct['6000'], amount: '30.00', description: 'Toner' },
      ],
    });
    const entryId = await postedEntryOf(bills, bill.id);
    const onOld = await lineOn(entryId, acct['6000']);
    expect(onOld).toHaveLength(2);
    const toner = onOld.find((l) => l.debit === '30.00')!;
    const res = await reclassifyLines(ctx, { lineIds: [toner.id], newAccountId: acct['6300'] });
    expect(res.documentsUpdated).toBe(1);

    const rows = await db.select().from(billLines).where(eq(billLines.billId, bill.id)).orderBy(asc(billLines.lineOrder));
    expect(rows.map((r) => [r.description, r.accountId])).toEqual([
      ['Paper', acct['6000']],
      ['Toner', acct['6300']],
    ]);
    await updateBill(ctx, bill.id, {
      vendorId,
      date: D('2026-03-05'),
      billNumber: 'RC-1',
      memo: 'memo changed',
      lines: rows.map((r) => ({ accountId: r.accountId, itemId: r.itemId, description: r.description, quantity: r.quantity, amount: r.amount, classId: r.classId })),
    });
    const [after] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect((await lineOn(after.postedEntryId!, acct['6300'])).map((l) => l.debit)).toEqual(['30.00']);
    expect((await lineOn(after.postedEntryId!, acct['6000'])).map((l) => l.debit)).toEqual(['70.00']);
    await expectBalanced();
  });

  it('check / expense: class-only reclassify is kept too', async () => {
    const cls = await createClass(ctx, { name: 'Durable West' });
    const exp = await createExpense(ctx, {
      vendorId,
      date: D('2026-03-06'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '55.00', description: 'Cleaning' }],
    });
    const entryId = await postedEntryOf(expenses, exp.id);
    const [line] = await lineOn(entryId, acct['6000']);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct['6400'], newClassId: cls.id });
    const rows = await db.select().from(expenseLines).where(eq(expenseLines.expenseId, exp.id));
    expect(rows[0].classId).toBe(cls.id);
    const [e] = await db.select().from(expenses).where(eq(expenses.id, exp.id));
    await updateExpense(ctx, exp.id, {
      vendorId,
      date: D('2026-03-06'),
      method: 'check',
      reference: e.reference,
      paymentAccountId: acct['1000'],
      memo: 'memo changed',
      lines: rows.map((r) => ({ accountId: r.accountId, itemId: r.itemId, description: r.description, amount: r.amount, classId: r.classId })),
    });
    const [after] = await db.select().from(expenses).where(eq(expenses.id, exp.id));
    const moved = await lineOn(after.postedEntryId!, acct['6400']);
    expect(moved).toHaveLength(1);
    expect(moved[0].classId).toBe(cls.id);
    await expectBalanced();
  });

  it('vendor credit (bill credit): same', async () => {
    const vc = await createVendorCredit(ctx, {
      vendorId,
      date: D('2026-03-07'),
      lines: [{ accountId: acct['6000'], amount: '25.00', description: 'Rebate' }],
    });
    const entryId = await postedEntryOf(vendorCredits, vc.id);
    const [line] = await lineOn(entryId, acct['6000']);
    const res = await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct['6300'] });
    expect(res.documentsUpdated).toBe(1);
    const rows = await db.select().from(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, vc.id));
    expect(rows[0].accountId).toBe(acct['6300']);
    await updateVendorCredit(ctx, vc.id, {
      vendorId,
      date: D('2026-03-07'),
      memo: 'memo changed',
      lines: rows.map((r) => ({ accountId: r.accountId, amount: r.amount, description: r.description })),
    });
    const [after] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(after.memo).toBe('memo changed');
    expect(await lineOn(after.postedEntryId!, acct['6300'])).toHaveLength(1);
    expect(await lineOn(after.postedEntryId!, acct['6000'])).toHaveLength(0);
    await expectBalanced();
  });

  it('deposit: extra line and cash back follow the reclassification', async () => {
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: D('2026-03-08'),
      memo: 'original',
      extraLines: [{ accountId: acct['3910'], amount: '500.00', description: 'Owner money' }],
      cashBack: { accountId: acct['3910'], amount: '20.00' },
    });
    const entryId = await postedEntryOf(deposits, dep.id);
    const extra = (await lineOn(entryId, acct['3910'])).find((l) => l.credit === '500.00')!;
    const res = await reclassifyLines(ctx, { lineIds: [extra.id], newAccountId: acct['3960'] });
    expect(res.documentsUpdated).toBe(1);
    const cashBack = (await lineOn(entryId, acct['3910'])).find((l) => l.debit === '20.00')!;
    await reclassifyLines(ctx, { lineIds: [cashBack.id], newAccountId: acct['3960'] });

    // Re-save from the deposit's own rows (as the edit form does), changing only the memo.
    const rows = await db.select().from(depositLines).where(eq(depositLines.depositId, dep.id));
    const extraRow = rows.find((r) => !(r.description ?? '').startsWith('cashback:'))!;
    const cbRow = rows.find((r) => (r.description ?? '').startsWith('cashback:'))!;
    expect(extraRow.accountId).toBe(acct['3960']);
    expect(cbRow.description).toBe(`cashback:${acct['3960']}`);
    await updateDeposit(ctx, dep.id, {
      depositAccountId: acct['1000'],
      date: D('2026-03-08'),
      memo: 'memo changed',
      extraLines: [{ accountId: extraRow.accountId!, amount: extraRow.amount, description: extraRow.description }],
      cashBack: { accountId: cbRow.description!.slice('cashback:'.length), amount: Math.abs(Number(cbRow.amount)).toFixed(2) },
    });
    const [after] = await db.select().from(deposits).where(eq(deposits.id, dep.id));
    expect(after.memo).toBe('memo changed');
    const lines = await lineOn(after.postedEntryId!, acct['3960']);
    expect(lines.map((l) => l.credit ?? `-${l.debit}`).sort()).toEqual(['-20.00', '500.00']);
    expect(await lineOn(after.postedEntryId!, acct['3910'])).toHaveLength(0);
    await expectBalanced();
  });

  it('invoice item line: moving its account is refused (QB parity); a class change is kept', async () => {
    const item = await createItem(ctx, { name: 'Design hour', type: 'service' as never, salesPrice: '90.00', incomeAccountId: acct['4000'] });
    const cls = await createClass(ctx, { name: 'Durable East' });
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-03-09'),
      lines: [{ itemId: item.id, description: 'Design', quantity: 2, rate: '90.00' }],
    });
    const entryId = await postedEntryOf(invoices, inv.id);
    const [income] = await lineOn(entryId, acct['4000']);
    await expect(reclassifyLines(ctx, { lineIds: [income.id], newAccountId: acct['4100'] })).rejects.toThrow(
      /comes from the item "Design hour"/,
    );
    // Nothing changed.
    expect((await lineOn(entryId, acct['4000']))[0].id).toBe(income.id);

    await reclassifyLines(ctx, { lineIds: [income.id], newClassId: cls.id });
    const rows = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    expect(rows[0].classId).toBe(cls.id);
    await updateInvoice(ctx, inv.id, {
      customerId,
      date: D('2026-03-09'),
      memo: 'memo changed',
      lines: rows.map((r) => ({ itemId: r.itemId, accountId: r.accountId, description: r.description, quantity: r.quantity, rate: r.rate, taxable: r.taxable, classId: r.classId })),
    });
    const [after] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    const [l] = await lineOn(after.postedEntryId!, acct['4000']);
    expect(l.classId).toBe(cls.id);
    await expectBalanced();
  });

  it('refuses a class change a document cannot keep, and lines of documents that rebuild themselves', async () => {
    const cls = await createClass(ctx, { name: 'Durable North' });
    const vc = await createVendorCredit(ctx, {
      vendorId,
      date: D('2026-03-10'),
      lines: [{ accountId: acct['6000'], amount: '12.00', description: 'Credit' }],
    });
    const [line] = await lineOn(await postedEntryOf(vendorCredits, vc.id), acct['6000']);
    await expect(reclassifyLines(ctx, { lineIds: [line.id], newClassId: cls.id })).rejects.toThrow(
      /doesn't keep a class on each line/,
    );
    const [unchanged] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, line.id));
    expect(unchanged.classId).toBeNull();
  });

  it('a mixed batch is all-or-nothing: one refused line blocks the others', async () => {
    const item = await createItem(ctx, { name: 'Widget fee', type: 'service' as never, salesPrice: '10.00', incomeAccountId: acct['4000'] });
    const plain = await createInvoice(ctx, {
      customerId,
      date: D('2026-03-11'),
      lines: [{ description: 'Plain', quantity: 1, rate: '15.00', accountId: acct['4000'] }],
    });
    const withItem = await createInvoice(ctx, {
      customerId,
      date: D('2026-03-11'),
      lines: [{ itemId: item.id, quantity: 1, rate: '10.00' }],
    });
    const [a] = await lineOn(await postedEntryOf(invoices, plain.id), acct['4000']);
    const [b] = await lineOn(await postedEntryOf(invoices, withItem.id), acct['4000']);
    await expect(reclassifyLines(ctx, { lineIds: [a.id, b.id], newAccountId: acct['4100'] })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const [still] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, a.id));
    expect(still.accountId).toBe(acct['4000']);
    const [docRow] = await db
      .select()
      .from(invoiceLines)
      .where(and(eq(invoiceLines.invoiceId, plain.id)));
    expect(docRow.accountId).toBe(acct['4000']);
    await expectBalanced();
  });
});
