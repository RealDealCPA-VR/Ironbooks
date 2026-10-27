/**
 * Review round 5 (fourth pass) — fixes for the reviewer's findings on the third pass.
 *
 *  A  A bill converted from a purchase order account line (quantity 3): the Enter Bills form
 *     re-sends that line as { accountId, description, amount } with no quantity. Saving the bill
 *     again (a date fix, or no change at all) keeps the line's quantity, so the P.O. stays billed
 *     and can't be billed a second time. Partial Receive & Bill of an account line too.
 *  B  An item receipt whose entry credited an account that is no longer recognised as the Item
 *     Receipts Accrual (receipts saved before the accrual lookup changed credited "whatever is
 *     numbered 2050"): billing it debits the account the receipt credited, so both net to zero.
 *  C  The Sales Tax Liability report's default period (lastFilingPeriod with no date) uses the
 *     local calendar day, not the UTC one.
 *  D  Pay Bills: picking a credit card account switches the method to Credit Card (and a bank
 *     account switches a Credit Card method back to Check).
 *  E  The purchase-document indexes of drizzle/0065 are declared in lib/db/schema.ts too.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  billLines,
  billPaymentApplications,
  billPayments,
  bills,
  expenseLines,
  expenses,
  itemReceiptLines,
  journalEntries,
  journalEntryLines,
  purchaseOrderLines,
  users,
  vendorCreditLines,
  vendors,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createItem } from './items';
import { getBill, updateBill } from './bills';
import { convertToBill, createPurchaseOrder, getPurchaseOrder } from './purchaseOrders';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-purchases4');
let db: DB;
const acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function newVendor(companyId = ctx.companyId) {
  seq += 1;
  const [v] = await db.insert(vendors).values({ companyId, displayName: `R5D Vendor ${seq}` }).returning();
  return v;
}

async function glBalance(companyId: string, accountId: string): Promise<string> {
  const rows = await db
    .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(eq(journalEntries.companyId, companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)),
    );
  const cents = rows.reduce((s, r) => s + Math.round(Number(r.d ?? 0) * 100) - Math.round(Number(r.c ?? 0) * 100), 0);
  return (cents / 100).toFixed(2);
}

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to be refused').not.toBeNull();
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

/** A company whose chart already has the user's own "2050 Equipment Loan" (a QB conversion). */
async function companyWithOldAccrual() {
  const [u] = await db.insert(users).values({ email: `r5d-2050-${++seq}@test.local`, name: 'R5D', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: `R5D 2050 Co ${seq}`, ownerId: u.id });
  const c2: ServiceContext = { db, companyId: company.id, userId: u.id };
  const a2: Record<string, string> = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) a2[r.code] = r.id;
  const item = await createItem(c2, {
    name: `R5D Gadget ${seq}`,
    type: 'inventory',
    assetAccountId: a2['1300'],
    incomeAccountId: a2['4000'] ?? a2['4100'],
    cogsAccountId: a2['5000'],
  } as never);
  const v = await newVendor(company.id);
  return { c2, a2, item, v };
}

/**
 * Receipts saved before the accrual lookup changed credited whatever account was numbered 2050.
 * Reproduce that: save the receipt (its entry credits the 2050 accrual created for it), then turn
 * that 2050 account into the user's own "Equipment Loan" (name and description), as a chart where
 * the user's 2050 was in use when the receipt was saved looks to the new lookup.
 */
async function receiptOnOldAccrual(c2: ServiceContext, vendorId: string, itemId: string, qty: number, cost: string) {
  const { createItemReceipt, findAccrualAccount } = await import('./itemReceipts');
  const receipt = await createItemReceipt(c2, { vendorId, date: d('2026-08-01'), lines: [{ itemId, quantity: qty, unitCost: cost }] });
  const old = await findAccrualAccount(c2);
  expect(old).not.toBeNull();
  await db.update(accounts).set({ name: 'Equipment Loan', description: 'Bank loan for the forklift' }).where(eq(accounts.id, old!));
  expect(await findAccrualAccount(c2)).toBeNull();
  return { receipt, oldAccountId: old! };
}

describe('review5 purchases (fourth pass)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'r5d-purchases@test.local', name: 'R5D P', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R5D Purchases Co', ownerId: u.id });
    ctx = { db, companyId: company.id, userId: u.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('A: re-saving a P.O. bill whose account line the form sends without a quantity keeps the P.O. billed', async () => {
    const v = await newVendor();
    const po = await createPurchaseOrder(ctx, {
      vendorId: v.id,
      date: d('2026-03-01'),
      lines: [{ accountId: acct['6000'], quantity: 3, rate: '10.00', description: 'Consulting hours' }],
    });
    const bill = await convertToBill(ctx, po.id, { date: d('2026-03-05') });
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('closed');
    const entryBefore = (await db.select().from(bills).where(eq(bills.id, bill.id)))[0].postedEntryId;

    // The Enter Bills form: { accountId, description, amount } (no quantity). Unchanged re-save:
    // nothing moves, and the edit is ledger-neutral (the entry is kept, not voided and reposted).
    const formLine = { accountId: acct['6000'], description: 'Consulting hours', amount: '30.00' };
    await updateBill(ctx, bill.id, { vendorId: v.id, date: d('2026-03-05'), lines: [formLine] });
    expect((await db.select().from(bills).where(eq(bills.id, bill.id)))[0].postedEntryId).toBe(entryBefore);

    // The bookkeeper fixes only the bill date.
    await updateBill(ctx, bill.id, { vendorId: v.id, date: d('2026-03-06'), lines: [formLine] });
    const after = await getPurchaseOrder(ctx, po.id);
    // Before: 'partial' with 1 billed, and a second Convert to Bill billed the same order again.
    expect(after.status).toBe('closed');
    expect(after.lines.map((l) => Number(l.quantityBilled))).toEqual([3]);
    expect((await getBill(ctx, bill.id)).lines.map((l) => Number(l.quantity))).toEqual([3]);
    expect((await refusal(convertToBill(ctx, po.id, { date: d('2026-03-07') }))).code).toBe('CONFLICT');

    // An explicit quantity still moves the P.O. (the API / a later form that shows it).
    await updateBill(ctx, bill.id, {
      vendorId: v.id,
      date: d('2026-03-06'),
      lines: [{ ...formLine, quantity: 2, amount: '20.00' }],
    });
    const moved = await getPurchaseOrder(ctx, po.id);
    expect(moved.status).toBe('partial');
    expect(moved.lines.map((l) => Number(l.quantityBilled))).toEqual([2]);
  });

  it('A2: a partial Receive & Bill of a P.O. account line keeps its quantity when the bill is re-saved', async () => {
    const v = await newVendor();
    const po = await createPurchaseOrder(ctx, {
      vendorId: v.id,
      date: d('2026-03-01'),
      lines: [{ accountId: acct['6000'], quantity: 5, rate: '10.00', description: 'Installation hours' }],
    });
    const [line] = (await getPurchaseOrder(ctx, po.id)).lines;
    const bill = await convertToBill(ctx, po.id, { date: d('2026-03-05'), lines: [{ lineId: line.id, quantity: 2 }] });
    expect((await getPurchaseOrder(ctx, po.id)).lines.map((l) => Number(l.quantityBilled))).toEqual([2]);

    await updateBill(ctx, bill.id, {
      vendorId: v.id,
      date: d('2026-03-08'),
      memo: 'corrected date',
      lines: [{ accountId: acct['6000'], description: 'Installation hours', amount: '20.00' }],
    });
    const after = await getPurchaseOrder(ctx, po.id);
    // Before: billed went from 2 to 1, so the other unit could be billed twice.
    expect(after.status).toBe('partial');
    expect(after.lines.map((l) => Number(l.quantityBilled))).toEqual([2]);
    // The rest (3) is what is left to bill.
    const rest = await convertToBill(ctx, po.id, { date: d('2026-03-10') });
    expect(rest.total).toBe('30.00');
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('closed');
  });

  it('A3: a memo fix on a bill for received items, saved from the Enter Bills form, is allowed', async () => {
    const v = await newVendor();
    const item = await createItem(ctx, {
      name: `R5D Widget ${++seq}`,
      type: 'inventory',
      assetAccountId: acct['1300'],
      incomeAccountId: acct['4000'] ?? acct['4100'],
      cogsAccountId: acct['5000'],
    } as never);
    const { createItemReceipt } = await import('./itemReceipts');
    const { enterBillForReceivedItems } = await import('./receiving');
    const receipt = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-04-01'), lines: [{ itemId: item.id, quantity: 4, unitCost: '10.00' }] });
    const bill = await enterBillForReceivedItems(ctx, {
      vendorId: v.id,
      date: d('2026-04-03'),
      lines: [{ receiptLineId: receipt.lines[0].id, quantity: 4, unitCost: '10.00' }],
    });
    const saved = await getBill(ctx, bill.id);
    // The form re-sends the accrual line as an expense line, without its quantity (4).
    await updateBill(ctx, bill.id, {
      vendorId: v.id,
      date: d('2026-04-03'),
      memo: 'Packing slip 7781',
      lines: saved.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? undefined, amount: l.amount })),
    });
    const after = await getBill(ctx, bill.id);
    expect(after.memo).toBe('Packing slip 7781');
    expect(after.postedEntryId).toBe(saved.postedEntryId);
    expect(after.lines.map((l) => Number(l.quantity))).toEqual([4]);
  });

  it('B: billing a receipt that credited the old 2050 account clears that account (Convert to Bill)', async () => {
    const { c2, item, v } = await companyWithOldAccrual();
    const { receipt, oldAccountId } = await receiptOnOldAccrual(c2, v.id, item.id, 5, '4.00');
    expect(await glBalance(c2.companyId, oldAccountId)).toBe('-20.00');
    const { convertToBill: convertReceipt, findAccrualAccount } = await import('./itemReceipts');
    const bill = await convertReceipt(c2, receipt.id);
    // Before: a new 2051 Item Receipts Accrual was debited 20.00 and the loan kept its 20.00 credit.
    expect(await glBalance(c2.companyId, oldAccountId)).toBe('0.00');
    const created = await findAccrualAccount(c2);
    if (created) expect(await glBalance(c2.companyId, created)).toBe('0.00');
    expect((await getBill(c2, bill.id)).lines.every((l) => l.accountId === oldAccountId)).toBe(true);
  });

  it('B2: Enter Bill for Received Items clears the account each receipt credited (old and new receipts on one bill)', async () => {
    const { c2, item, v } = await companyWithOldAccrual();
    const { receipt: oldReceipt, oldAccountId } = await receiptOnOldAccrual(c2, v.id, item.id, 5, '4.00');
    const { createItemReceipt, findAccrualAccount } = await import('./itemReceipts');
    // A receipt saved after the upgrade credits the new Item Receipts Accrual (2051).
    const newReceipt = await createItemReceipt(c2, { vendorId: v.id, date: d('2026-08-02'), lines: [{ itemId: item.id, quantity: 2, unitCost: '7.00' }] });
    const accrual = await findAccrualAccount(c2);
    expect(accrual).not.toBeNull();
    expect(accrual).not.toBe(oldAccountId);
    expect(await glBalance(c2.companyId, accrual!)).toBe('-14.00');

    const { enterBillForReceivedItems, previewReceiptBill } = await import('./receiving');
    const input = {
      vendorId: v.id,
      date: d('2026-08-10'),
      lines: [
        { receiptLineId: oldReceipt.lines[0].id, quantity: 5, unitCost: '4.50' },
        { receiptLineId: newReceipt.lines[0].id, quantity: 2, unitCost: '7.00' },
      ],
    };
    const preview = await previewReceiptBill(c2, input);
    const relieved = (id: string) => preview.postingLines.find((p) => p.accountId === id)?.debit ?? null;
    expect(relieved(oldAccountId)).toBe('20.00');
    expect(relieved(accrual!)).toBe('14.00');

    const bill = await enterBillForReceivedItems(c2, input);
    expect(bill.total).toBe('36.50');
    // Before: the 2051 accrual was debited 34.00 (-14 + 34 = 20.00 left over) and the loan kept -20.00.
    expect(await glBalance(c2.companyId, oldAccountId)).toBe('0.00');
    expect(await glBalance(c2.companyId, accrual!)).toBe('0.00');
    const lines = (await getBill(c2, bill.id)).lines;
    expect(lines.filter((l) => l.accountId === oldAccountId).map((l) => l.amount)).toEqual(['20.00']);
    expect(lines.filter((l) => l.accountId === accrual).map((l) => l.amount)).toEqual(['14.00']);
  });

  it('C: the Sales Tax Liability report defaults to the last period by the local calendar day', async () => {
    const { lastFilingPeriod } = await import('./accountant/salesTaxLedger');
    const prev = process.env.TZ;
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 10:30 PM on Sep 30 in New York — already Oct 1 in UTC.
      vi.setSystemTime(new Date('2026-10-01T02:30:00.000Z'));
      // Before: Jul 1 – Sep 30 (the quarter still running) and Sep 1 – 30 (the month still running).
      expect(lastFilingPeriod('quarterly')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
      expect(lastFilingPeriod('monthly')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
      expect(lastFilingPeriod('annually')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    } finally {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it('D: Pay Bills switches the method to Credit Card for a card account (and back to Check for a bank)', async () => {
    const { methodForPaymentAccount } = await import('@/lib/billPaymentMethod');
    const bank = { type: 'asset', subtype: 'checking' };
    const card = { type: 'liability', subtype: 'credit_card' };
    // Before: the method stayed on Check, and the save was refused for a check on a credit card.
    expect(methodForPaymentAccount(card, 'check')).toBe('credit_card');
    expect(methodForPaymentAccount(card, 'ach')).toBe('credit_card');
    expect(methodForPaymentAccount(bank, 'credit_card')).toBe('check');
    // A method that fits the bank account is kept.
    expect(methodForPaymentAccount(bank, 'ach')).toBe('ach');
    expect(methodForPaymentAccount(bank, 'check')).toBe('check');
    expect(methodForPaymentAccount(null, 'check')).toBe('check');

    // The server still refuses a check on a card account with the plain message.
    const { createBill } = await import('./bills');
    const { payBills } = await import('./billPayments');
    const v = await newVendor();
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-05-01'), lines: [{ accountId: acct['6000'], amount: '40.00' }] });
    const [cardRow] = await db.select().from(accounts).where(eq(accounts.id, acct['2100']));
    const asCheck = await refusal(
      payBills(ctx, {
        vendorId: v.id,
        date: d('2026-05-02'),
        method: 'check',
        paymentAccountId: cardRow.id,
        applications: [{ billId: bill.id, amountApplied: '40.00' }],
      }),
    );
    expect(asCheck.message).toMatch(/check is written on a bank account/i);
    // What the page now sends after the card account is picked: saved.
    const pay = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-05-02'),
      method: methodForPaymentAccount(cardRow, 'check') as never,
      paymentAccountId: cardRow.id,
      applications: [{ billId: bill.id, amountApplied: '40.00' }],
    });
    expect(pay?.method).toBe('credit_card');
  });
  it('E: the 0065 indexes are declared in the schema and exist in the migrated database', async () => {
    const tables = [bills, billLines, billPayments, billPaymentApplications, expenses, expenseLines, vendorCreditLines, purchaseOrderLines, itemReceiptLines];
    const declared = tables.flatMap((t) => {
      const cfg = getTableConfig(t);
      return cfg.indexes.map((i) => `${cfg.name}.${i.config.name}(${i.config.columns.map((c) => (c as { name: string }).name).join(',')})`);
    });
    expect(declared.sort()).toEqual(
      [
        'bills.bills_company_vendor_idx(company_id,vendor_id)',
        'bill_lines.bill_lines_bill_idx(bill_id)',
        'bill_payments.bill_payments_company_account_idx(company_id,payment_account_id)',
        'bill_payment_applications.bill_payment_applications_bill_idx(bill_id)',
        'bill_payment_applications.bill_payment_applications_payment_idx(bill_payment_id)',
        'expenses.expenses_company_account_idx(company_id,payment_account_id)',
        'expense_lines.expense_lines_expense_idx(expense_id)',
        'vendor_credit_lines.vendor_credit_lines_credit_idx(vendor_credit_id)',
        'purchase_order_lines.purchase_order_lines_po_idx(purchase_order_id)',
        'item_receipt_lines.item_receipt_lines_receipt_idx(item_receipt_id)',
      ].sort(),
    );
    const res = (await db.execute(
      sql`select indexname from pg_indexes where schemaname = 'public' and indexname like any (array['bill%_idx', 'expense%_idx', 'vendor_credit_lines_credit_idx', 'purchase_order_lines_po_idx', 'item_receipt_lines_receipt_idx'])`,
    )) as unknown as { rows: Array<{ indexname: string }> };
    const live = new Set(res.rows.map((r) => r.indexname));
    for (const name of declared.map((d) => d.split('.')[1].split('(')[0])) expect(live.has(name), name).toBe(true);
  });
});
