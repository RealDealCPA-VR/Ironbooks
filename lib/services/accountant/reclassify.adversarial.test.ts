/**
 * Team ledger fix — TESTER (independent adversarial QA) for P0 "Reclassify can be undone silently by
 * re-saving the source document".
 *
 * Every case re-saves the document the way the edit form does — from the document's own `get*`
 * service (not raw table rows) — changing only the memo (or another line), and then checks that the
 * reclassified account / class is still on the re-posted entry, that nothing else moved, and that
 * the trial balance stays balanced. Hard matching cases: twin lines (same account, amount and
 * description), item + account lines on the same account, several classes on one account,
 * reclassifying twice, credit-card credits, closing date, and refusals leaving nothing changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bills, deposits, expenses, invoices, journalEntryLines, salesReceipts, users, vendorCredits } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate } from '../company';
import { createAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createClass } from '../dimensions';
import { createItem } from '../items';
import { createInvoice, getInvoice, updateInvoice } from '../invoices';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt } from '../salesReceipts';
import { createBill, getBill, updateBill } from '../bills';
import { createExpense, getExpense, updateExpense } from '../expenses';
import { createVendorCredit, getVendorCredit, updateVendorCredit } from '../vendorCredits';
import { createDeposit, getDeposit, updateDeposit } from '../deposits';
import { trialBalance } from '../reports';
import { reclassifyLines } from './reclassify';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reclassify-adversarial');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let ccAccountId: string;
let customerId: string;
let vendorId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);

async function linesOf(entryId: string) {
  return db
    .select()
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entryId))
    .orderBy(asc(journalEntryLines.createdAt));
}
const on = async (entryId: string, accountId: string) => (await linesOf(entryId)).filter((l) => l.accountId === accountId);
const amt = (l: { debit: string | null; credit: string | null }) => (l.debit != null && Number(l.debit) > 0 ? l.debit : l.credit);

async function posted(
  table: typeof bills | typeof expenses | typeof invoices | typeof vendorCredits | typeof deposits | typeof salesReceipts,
  id: string,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [row] = await db.select().from(table as any).where(eq((table as any).id, id));
  return (row as { postedEntryId: string }).postedEntryId;
}

async function expectBalanced() {
  const tb = await trialBalance(ctx);
  expect(Number(tb.totalDebit)).toBeCloseTo(Number(tb.totalCredit), 2);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'reclass-adv@test.local', name: 'Reclass QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Reclassify QA Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  for (const a of all) acct[a.code] = a.id;
  ccAccountId = all.find((a) => a.subtype === 'credit_card')?.id as string;
  acct['4810'] = (await createAccount(ctx, { code: '4810', name: 'QA Income A', type: 'revenue' as never, subtype: 'sales' })).id;
  acct['4820'] = (await createAccount(ctx, { code: '4820', name: 'QA Income B', type: 'revenue' as never, subtype: 'sales' })).id;
  acct['6810'] = (await createAccount(ctx, { code: '6810', name: 'QA Expense A', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct['6820'] = (await createAccount(ctx, { code: '6820', name: 'QA Expense B', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct['6830'] = (await createAccount(ctx, { code: '6830', name: 'QA Expense C', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct['3810'] = (await createAccount(ctx, { code: '3810', name: 'QA Equity A', type: 'equity' as never, subtype: 'owners_equity' })).id;
  acct['3820'] = (await createAccount(ctx, { code: '3820', name: 'QA Equity B', type: 'equity' as never, subtype: 'owners_equity' })).id;
  customerId = (await createCustomer(ctx, { displayName: 'Reclass QA Customer' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'Reclass QA Vendor' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

type BillLike = Awaited<ReturnType<typeof getBill>>;
function billInput(b: BillLike, memo: string) {
  return {
    vendorId: b.vendorId,
    date: b.date,
    billNumber: b.billNumber,
    memo,
    lines: b.lines.map((r) => ({
      accountId: r.accountId,
      itemId: r.itemId,
      description: r.description,
      quantity: r.quantity,
      amount: r.amount,
      classId: r.classId,
    })),
  };
}

describe('reclassify durability — adversarial', () => {
  it('bill with TWIN lines (same account, amount, description): reclassify one, re-save → exactly one moved', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: D('2026-06-01'),
      billNumber: 'TW-1',
      lines: [
        { accountId: acct['6810'], amount: '40.00', description: 'Same' },
        { accountId: acct['6810'], amount: '40.00', description: 'Same' },
      ],
    });
    const entry = await posted(bills, bill.id);
    const [first] = await on(entry, acct['6810']);
    await reclassifyLines(ctx, { lineIds: [first.id], newAccountId: acct['6820'] });
    await updateBill(ctx, bill.id, billInput(await getBill(ctx, bill.id), 'memo only'));
    const after = await posted(bills, bill.id);
    expect((await on(after, acct['6820'])).map(amt)).toEqual(['40.00']);
    expect((await on(after, acct['6810'])).map(amt)).toEqual(['40.00']);
    await expectBalanced();
  });

  it('bill: reclassify twice (A→B, then B→C) on a partial slice, then re-save', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: D('2026-06-02'),
      billNumber: 'TW-2',
      lines: [
        { accountId: acct['6810'], amount: '11.00', description: 'Keep' },
        { accountId: acct['6810'], amount: '22.00', description: 'Move' },
      ],
    });
    const entry = await posted(bills, bill.id);
    const move = (await on(entry, acct['6810'])).find((l) => l.debit === '22.00')!;
    await reclassifyLines(ctx, { lineIds: [move.id], newAccountId: acct['6820'] });
    await reclassifyLines(ctx, { lineIds: [move.id], newAccountId: acct['6830'] });
    // Re-save, also changing the OTHER line's amount.
    const b = await getBill(ctx, bill.id);
    const input = billInput(b, 'edited');
    input.lines = input.lines.map((l) => (l.description === 'Keep' ? { ...l, amount: '12.00' } : l));
    await updateBill(ctx, bill.id, input);
    const after = await posted(bills, bill.id);
    expect((await on(after, acct['6830'])).map(amt)).toEqual(['22.00']);
    expect((await on(after, acct['6810'])).map(amt)).toEqual(['12.00']);
    expect(await on(after, acct['6820'])).toHaveLength(0);
    await expectBalanced();
  });

  it('check: account line and item line on the same account — reclassifying the account line moves only it', async () => {
    const item = await createItem(ctx, { name: 'QA Supply Item', type: 'non_inventory' as never, expenseAccountId: acct['6810'] });
    const exp = await createExpense(ctx, {
      vendorId,
      date: D('2026-06-03'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [
        { itemId: item.id, quantity: 1, unitCost: '25.00', amount: '25.00', description: 'Item row' },
        { accountId: acct['6810'], amount: '25.00', description: 'Account row' },
      ],
    });
    const entry = await posted(expenses, exp.id);
    const lines = await on(entry, acct['6810']);
    expect(lines).toHaveLength(2);
    const accountLine = lines.find((l) => l.memo === 'Account row') ?? lines[1];
    await reclassifyLines(ctx, { lineIds: [accountLine.id], newAccountId: acct['6820'] });
    const e = await getExpense(ctx, exp.id);
    await updateExpense(ctx, exp.id, {
      vendorId,
      date: e.date,
      method: 'check',
      reference: e.reference,
      paymentAccountId: acct['1000'],
      memo: 'memo only',
      lines: e.lines.map((r) => ({
        accountId: r.itemId ? null : r.accountId,
        itemId: r.itemId,
        quantity: r.quantity,
        unitCost: r.unitCost,
        description: r.description,
        amount: r.amount,
        classId: r.classId,
      })),
    });
    const after = await posted(expenses, exp.id);
    expect((await on(after, acct['6820'])).map((l) => l.memo)).toEqual(['Account row']);
    expect((await on(after, acct['6810'])).map((l) => l.memo)).toEqual(['Item row']);
    await expectBalanced();
  });

  it('bill item line: moving its account is refused and changes nothing (journal or bill rows)', async () => {
    const item = await createItem(ctx, { name: 'QA Part', type: 'non_inventory' as never, expenseAccountId: acct['6810'] });
    const bill = await createBill(ctx, {
      vendorId,
      date: D('2026-06-04'),
      billNumber: 'IT-1',
      lines: [{ itemId: item.id, quantity: 2, amount: '30.00', description: 'Parts' }],
    });
    const entry = await posted(bills, bill.id);
    const [line] = await on(entry, acct['6810']);
    await expect(reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct['6820'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [still] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, line.id));
    expect(still.accountId).toBe(acct['6810']);
    expect((await getBill(ctx, bill.id)).lines[0].accountId ?? acct['6810']).toBe(acct['6810']);
  });

  it('credit-card credit (refund): reclassify one of its expense lines, re-save → kept', async () => {
    expect(ccAccountId).toBeTruthy();
    const exp = await createExpense(ctx, {
      vendorId,
      date: D('2026-06-05'),
      method: 'credit_card',
      paymentAccountId: ccAccountId,
      isRefund: true,
      lines: [
        { accountId: acct['6810'], amount: '18.00', description: 'Refund A' },
        { accountId: acct['6810'], amount: '7.00', description: 'Refund B' },
      ],
    });
    const entry = await posted(expenses, exp.id);
    const b = (await on(entry, acct['6810'])).find((l) => amt(l) === '7.00')!;
    await reclassifyLines(ctx, { lineIds: [b.id], newAccountId: acct['6820'] });
    const e = await getExpense(ctx, exp.id);
    await updateExpense(ctx, exp.id, {
      vendorId,
      date: e.date,
      method: 'credit_card',
      paymentAccountId: ccAccountId,
      isRefund: true,
      memo: 'memo only',
      lines: e.lines.map((r) => ({
        accountId: r.accountId,
        itemId: r.itemId,
        description: r.description,
        amount: String(Math.abs(Number(r.amount)).toFixed(2)),
        classId: r.classId,
      })),
    });
    const after = await posted(expenses, exp.id);
    expect((await on(after, acct['6820'])).map((l) => l.credit)).toEqual(['7.00']);
    expect((await on(after, acct['6810'])).map((l) => l.credit)).toEqual(['18.00']);
    await expectBalanced();
  });

  it('invoice: one account split across two classes — reclassify only one class slice, re-save via getInvoice', async () => {
    const east = await createClass(ctx, { name: 'QA East' });
    const west = await createClass(ctx, { name: 'QA West' });
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-06-06'),
      lines: [
        { description: 'East work', quantity: 1, rate: '100.00', accountId: acct['4810'], classId: east.id },
        { description: 'West work', quantity: 1, rate: '60.00', accountId: acct['4810'], classId: west.id },
      ],
    });
    const entry = await posted(invoices, inv.id);
    const westLine = (await on(entry, acct['4810'])).find((l) => l.classId === west.id)!;
    await reclassifyLines(ctx, { lineIds: [westLine.id], newAccountId: acct['4820'] });
    const i = await getInvoice(ctx, inv.id);
    await updateInvoice(ctx, inv.id, {
      customerId,
      date: i.date,
      memo: 'memo only',
      lines: i.lines.map((r) => ({
        itemId: r.itemId,
        accountId: r.accountId,
        description: r.description,
        quantity: r.quantity,
        rate: r.rate,
        taxable: r.taxable,
        classId: r.classId,
      })),
    });
    const after = await posted(invoices, inv.id);
    expect((await on(after, acct['4820'])).map((l) => [l.credit, l.classId])).toEqual([['60.00', west.id]]);
    expect((await on(after, acct['4810'])).map((l) => [l.credit, l.classId])).toEqual([['100.00', east.id]]);
    await expectBalanced();
  });

  it('sales receipt: two rows on one account (one posted line) both follow, re-save via getSalesReceipt', async () => {
    const sr = await createSalesReceipt(ctx, {
      customerId,
      date: D('2026-06-07'),
      depositAccountId: acct['1000'],
      lines: [
        { description: 'Row 1', quantity: 1, rate: '15.00', accountId: acct['4810'] },
        { description: 'Row 2', quantity: 2, rate: '5.00', accountId: acct['4810'] },
      ],
    });
    const entry = await posted(salesReceipts, sr.id);
    const [line] = await on(entry, acct['4810']);
    await reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct['4820'] });
    const s = await getSalesReceipt(ctx, sr.id);
    await updateSalesReceipt(ctx, sr.id, {
      customerId,
      date: s.date,
      depositAccountId: acct['1000'],
      memo: 'memo only',
      lines: s.lines.map((r) => ({ itemId: r.itemId, accountId: r.accountId, description: r.description, quantity: r.quantity, rate: r.rate, taxable: r.taxable })),
    });
    const after = await posted(salesReceipts, sr.id);
    expect((await on(after, acct['4820'])).map((l) => l.credit)).toEqual(['25.00']);
    expect(await on(after, acct['4810'])).toHaveLength(0);
    await expectBalanced();
  });

  it('vendor credit: partial move of one of two lines on the same account, re-save via getVendorCredit', async () => {
    const vc = await createVendorCredit(ctx, {
      vendorId,
      date: D('2026-06-08'),
      lines: [
        { accountId: acct['6810'], amount: '9.00', description: 'Stay' },
        { accountId: acct['6810'], amount: '4.00', description: 'Go' },
      ],
    });
    const entry = await posted(vendorCredits, vc.id);
    const go = (await on(entry, acct['6810'])).find((l) => l.credit === '4.00')!;
    await reclassifyLines(ctx, { lineIds: [go.id], newAccountId: acct['6820'] });
    const v = await getVendorCredit(ctx, vc.id);
    await updateVendorCredit(ctx, vc.id, {
      vendorId,
      date: v.date,
      memo: 'memo only',
      lines: v.lines.map((r) => ({ accountId: r.accountId, amount: r.amount, description: r.description })),
    });
    const after = await posted(vendorCredits, vc.id);
    expect((await on(after, acct['6820'])).map((l) => l.credit)).toEqual(['4.00']);
    expect((await on(after, acct['6810'])).map((l) => l.credit)).toEqual(['9.00']);
    await expectBalanced();
  });

  it('deposit: two extra lines on the same account and amount — reclassify one, re-save via getDeposit (edit form shape)', async () => {
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: D('2026-06-09'),
      extraLines: [
        { accountId: acct['3810'], amount: '100.00', description: 'Owner A' },
        { accountId: acct['3810'], amount: '100.00', description: 'Owner B' },
      ],
    });
    const entry = await posted(deposits, dep.id);
    const b = (await on(entry, acct['3810'])).find((l) => l.memo === 'Owner B') ?? (await on(entry, acct['3810']))[1];
    await reclassifyLines(ctx, { lineIds: [b.id], newAccountId: acct['3820'] });
    const d = await getDeposit(ctx, dep.id);
    const extra = d.lines.filter((l) => !l.paymentId && !(l.description ?? '').startsWith('cashback:') && !(l.description ?? '').startsWith('salesReceipt:'));
    expect(extra.every((l) => l.accountId)).toBe(true);
    await updateDeposit(ctx, dep.id, {
      depositAccountId: acct['1000'],
      date: d.date,
      memo: 'memo only',
      extraLines: extra.map((l) => ({ accountId: l.accountId!, amount: l.amount, description: l.description })),
    });
    const after = await posted(deposits, dep.id);
    expect((await on(after, acct['3820'])).map((l) => l.credit)).toEqual(['100.00']);
    expect((await on(after, acct['3810'])).map((l) => l.credit)).toEqual(['100.00']);
    await expectBalanced();
  });

  it('closing date: reclassifying a line in a closed period is refused and the document rows stay put', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: D('2026-01-15'),
      billNumber: 'CL-1',
      lines: [{ accountId: acct['6810'], amount: '50.00', description: 'Closed' }],
    });
    const entry = await posted(bills, bill.id);
    const [line] = await on(entry, acct['6810']);
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'pw' });
    try {
      await expect(reclassifyLines(ctx, { lineIds: [line.id], newAccountId: acct['6820'] })).rejects.toThrow();
    } finally {
      await setClosingDate(ctx, { closingDate: null, password: null });
    }
    expect((await getBill(ctx, bill.id)).lines[0].accountId).toBe(acct['6810']);
    const [still] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, line.id));
    expect(still.accountId).toBe(acct['6810']);
  });
});
