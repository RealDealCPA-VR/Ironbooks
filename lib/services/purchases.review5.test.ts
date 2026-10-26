/**
 * Review round 5 — purchases / A/P / checks / sales tax regressions.
 *
 *  A  Enter Bill for Received Items takes its terms and due date from the vendor (A/P aging).
 *  B  Landed cost from a foreign-currency bill moves the HOME amount the bill posted.
 *  C  Pay credit card for a reconciliation: a double submit posts one payment, not two.
 *  D  Sales tax rates / components: NaN, Infinity and non-numbers are refused (400), never stored.
 *  E  Pay Liabilities / Pay Sales Tax: a non-numeric amount or bad date is a 400, not a 500.
 *  F  Vendor credit apply / unapply / refund: a non-numeric amount is a 400, not a 500.
 *  G  Bills / checks: an item line whose amount differs from qty x unit cost stocks the units at
 *     the amount actually posted (FIFO layers / average cost == inventory GL).
 *  H  Pay Bills by check (not "To be printed") with no number gets the next check number, as QB
 *     assigns it; editing such a payment keeps its number.
 *  I  Two first item receipts saved at once share ONE 2050 Item Receipts Accrual account.
 *  J  Text longer than its column (bill number, vendor name, check number) is a 400, not a 500.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  bills,
  inventoryLayers,
  items,
  journalEntries,
  journalEntryLines,
  taxRates,
  users,
  vendors,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createItem } from './items';
import { createBill } from './bills';
import { payBills, updateBillPayment } from './billPayments';
import { createVendor } from './vendors';
import { createExpense } from './expenses';
import { createItemReceipt } from './itemReceipts';
import { enterBillForReceivedItems } from './receiving';
import { allocateLandedCost } from './landedCost';
import { upsertCurrency, setBaseCurrency } from './currencies';
import { payCreditCard, payPayrollLiabilities, paySalesTax } from './liabilityPayments';
import { createTaxRate, updateTaxRate } from './salesTax';
import { setComponents } from './combinedTax';
import { createVendorCredit, applyToBill, unapplyFromBill, refundVendorCredit } from './vendorCredits';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-purchases');
let db: DB;
let ctx: ServiceContext;
let userId: string;
const acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function newVendor(extra: Partial<typeof vendors.$inferInsert> = {}) {
  seq += 1;
  const [v] = await db
    .insert(vendors)
    .values({ companyId: ctx.companyId, displayName: `R5 Vendor ${seq}`, ...extra })
    .returning();
  return v;
}

async function newInventoryItem(name: string) {
  return createItem(ctx, {
    name: `${name} ${++seq}`,
    type: 'inventory',
    assetAccountId: acct['1300'],
    incomeAccountId: acct['4000'],
    cogsAccountId: acct['5000'],
  } as never);
}

async function glBalance(accountId: string): Promise<string> {
  const rows = await db
    .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, accountId),
      ),
    );
  const cents = rows.reduce((s, r) => s + Math.round(Number(r.d ?? 0) * 100) - Math.round(Number(r.c ?? 0) * 100), 0);
  return (cents / 100).toFixed(2);
}

/** Expect a ServiceError with this code (never a raw Error that a route turns into a 500). */
async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to be refused').not.toBeNull();
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
}

describe('review5 purchases', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'r5-purchases@test.local', name: 'R5 P', passwordHash: 'x' }).returning();
    userId = u.id;
    const company = await createCompany(db, { name: 'R5 Purchases Co', ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
    if (!acct['4000']) {
      acct['4000'] = (await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue' as never, subtype: 'sales' })).id;
    }
    acct['6050'] = (await createAccount(ctx, { code: '6050', name: 'Freight In', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('A: a bill for received items is due on the vendor terms (not on the bill date)', async () => {
    const v = await newVendor({ terms: 'net_30' });
    const item = await newInventoryItem('Widget A');
    const receipt = await createItemReceipt(ctx, {
      vendorId: v.id,
      date: d('2026-01-05'),
      lines: [{ itemId: item.id, quantity: 4, unitCost: '10.00' }],
    });
    const bill = await enterBillForReceivedItems(ctx, {
      vendorId: v.id,
      billNumber: 'RCV-1',
      date: d('2026-01-10'),
      lines: [{ receiptLineId: receipt.lines[0].id, quantity: 4, unitCost: '10.00' }],
    });
    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(row.terms).toBe('net_30');
    expect(row.dueDate?.toISOString().slice(0, 10)).toBe('2026-02-09');

    // An explicit due date still wins.
    const receipt2 = await createItemReceipt(ctx, {
      vendorId: v.id,
      date: d('2026-01-05'),
      lines: [{ itemId: item.id, quantity: 1, unitCost: '10.00' }],
    });
    const bill2 = await enterBillForReceivedItems(ctx, {
      vendorId: v.id,
      date: d('2026-01-10'),
      dueDate: d('2026-01-20'),
      lines: [{ receiptLineId: receipt2.lines[0].id, quantity: 1, unitCost: '10.00' }],
    });
    const [row2] = await db.select().from(bills).where(eq(bills.id, bill2.id));
    expect(row2.dueDate?.toISOString().slice(0, 10)).toBe('2026-01-20');
  });

  it('B: landed cost from a foreign-currency bill relieves the charge account by the home amount posted', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const homeVendor = await newVendor();
    const eurVendor = await newVendor({ currency: 'EUR' });
    const item = await newInventoryItem('Widget B');
    const receipt = await createItemReceipt(ctx, {
      vendorId: homeVendor.id,
      date: d('2026-02-01'),
      lines: [{ itemId: item.id, quantity: 10, unitCost: '5.00' }],
    });
    const freightBefore = await glBalance(acct['6050']);
    // EUR 100.00 of freight at 1.20 = USD 120.00 on Freight In.
    const bill = await createBill(ctx, {
      vendorId: eurVendor.id,
      date: d('2026-02-02'),
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [{ accountId: acct['6050'], amount: '100.00' }],
    });
    expect(Number(await glBalance(acct['6050'])) - Number(freightBefore)).toBeCloseTo(120, 2);
    const [line] = await db.query.billLines.findMany({ where: (bl, { eq: e }) => e(bl.billId, bill.id) });
    const invBefore = await glBalance(acct['1300']);
    await allocateLandedCost(ctx, { billId: bill.id, billLineId: line.id, method: 'quantity', itemReceiptIds: [receipt.id] });
    // The whole USD 120.00 moves into the stock: Freight In back to where it was.
    expect(await glBalance(acct['6050'])).toBe(freightBefore);
    expect(Number(await glBalance(acct['1300'])) - Number(invBefore)).toBeCloseTo(120, 2);
    // Nothing left to allocate.
    await expectCode(
      allocateLandedCost(ctx, { billId: bill.id, billLineId: line.id, method: 'quantity', itemReceiptIds: [receipt.id] }),
      'VALIDATION',
    );
  });

  it('C: paying a credit card for a reconciliation twice at once posts one payment', async () => {
    const recId = '11111111-2222-4333-8444-555555555555';
    const input = {
      creditCardAccountId: acct['2100'],
      paymentAccountId: acct['1000'],
      amount: '75.00',
      date: d('2026-03-01'),
      reconciliationId: recId,
    };
    const results = await Promise.allSettled([payCreditCard(ctx, input), payCreditCard(ctx, input)]);
    const posted = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, `cc-payment:${recId}`),
          eq(journalEntries.status, 'posted'),
        ),
      );
    expect(posted).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('D: sales tax rates refuse NaN / Infinity / non-numbers', async () => {
    for (const rate of ['NaN', 'Infinity', 'abc', '-Infinity']) {
      await expectCode(createTaxRate(ctx, { name: `Bad ${rate}`, rate }), 'VALIDATION');
    }
    const stored = await db.select().from(taxRates).where(eq(taxRates.companyId, ctx.companyId));
    expect(stored.filter((r) => r.name.startsWith('Bad '))).toHaveLength(0);

    const good = await createTaxRate(ctx, { name: 'Good 5%', rate: '0.05' });
    await expectCode(updateTaxRate(ctx, good.id, { rate: 'NaN' }), 'VALIDATION');
    await expectCode(updateTaxRate(ctx, good.id, { rate: 'abc' }), 'VALIDATION');
    await expectCode(setComponents(ctx, good.id, [{ name: 'State', rate: 'NaN' }]), 'VALIDATION');
    await expectCode(setComponents(ctx, good.id, [{ name: 'State', rate: 'abc' }]), 'VALIDATION');
    await expectCode(setComponents(ctx, good.id, [{ name: 'State', rate: { x: 1 } as never }]), 'VALIDATION');
    const [after] = await db.select().from(taxRates).where(eq(taxRates.id, good.id));
    expect(after.rate).toBe('0.050000');
  });

  it('E: Pay Liabilities / Pay Sales Tax refuse a non-numeric amount or an invalid date with a 400', async () => {
    await expectCode(
      payPayrollLiabilities(ctx, { amount: 'abc', date: d('2026-03-05'), paymentAccountId: acct['1000'] }),
      'VALIDATION',
    );
    await expectCode(
      payPayrollLiabilities(ctx, { amount: '10.00', date: new Date('garbage'), paymentAccountId: acct['1000'] }),
      'VALIDATION',
    );
    await expectCode(paySalesTax(ctx, { amount: 'abc', date: d('2026-03-05'), paymentAccountId: acct['1000'] }), 'VALIDATION');
    await expectCode(
      paySalesTax(ctx, { amount: '10.00', date: new Date('garbage'), paymentAccountId: acct['1000'] }),
      'VALIDATION',
    );
    await expectCode(
      payCreditCard(ctx, { creditCardAccountId: acct['2100'], paymentAccountId: acct['1000'], amount: 'abc', date: d('2026-03-05') }),
      'VALIDATION',
    );
  });

  it('F: vendor credit apply / unapply / refund refuse a non-numeric amount with a 400', async () => {
    const v = await newVendor();
    const credit = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-04-01'), lines: [{ accountId: acct['6300'], amount: '20.00' }] });
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-01'), lines: [{ accountId: acct['6300'], amount: '50.00' }] });
    await expectCode(applyToBill(ctx, { vendorCreditId: credit.id, billId: bill.id, amount: 'abc' }), 'VALIDATION');
    await expectCode(applyToBill(ctx, { vendorCreditId: credit.id, billId: bill.id, amount: {} as never }), 'VALIDATION');
    await expectCode(unapplyFromBill(ctx, { vendorCreditId: credit.id, billId: bill.id, amount: 'abc' }), 'VALIDATION');
    await expectCode(refundVendorCredit(ctx, { vendorCreditId: credit.id, bankAccountId: acct['1000'], amount: 'abc' }), 'VALIDATION');
  });

  it('G: an item line whose amount differs from qty x unit cost stocks the units at the amount posted', async () => {
    const { receiveStock } = await import('./fifo');
    const v = await newVendor();
    // FIFO item (it has layers).
    const fifo = await newInventoryItem('Fifo G');
    await receiveStock(ctx, { itemId: fifo.id, quantity: 1, unitCost: '4.00', date: d('2026-05-01') });
    const bill = await createBill(ctx, {
      vendorId: v.id,
      date: d('2026-05-02'),
      lines: [{ itemId: fifo.id, quantity: 4, unitCost: '5.00', amount: '24.00' }],
    });
    const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.sourceRef, `bill:${bill.id}`));
    expect(layers).toHaveLength(1);
    // QB recalculates the cost from the amount: 24.00 / 4 = 6.00 (what Inventory Asset was debited).
    expect(layers[0].unitCost).toBe('6.0000');

    // Average-cost item on a check: average follows the amount posted.
    const avg = await newInventoryItem('Avg G');
    await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-05-03'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ itemId: avg.id, quantity: 2, unitCost: '1.00', amount: '30.00' }],
    });
    const [avgRow] = await db.select().from(items).where(eq(items.id, avg.id));
    expect(avgRow.averageCost).toBe('15.0000');
  });

  it('H: a check bill payment without a number gets the next check number (and keeps it on edit)', async () => {
    const v = await newVendor();
    // A Write Checks check numbers the account first.
    const chk = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-06-01'),
      method: 'check',
      reference: '7001',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '5.00' }],
    });
    expect(chk.reference).toBe('7001');
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-06-01'), lines: [{ accountId: acct['6300'], amount: '40.00' }] });
    const pay = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-06-02'),
      method: 'check',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '25.00' }],
    });
    expect(pay.reference).toBe('7002');
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, pay.postedEntryId!));
    expect(entry.reference).toBe('7002');
    // Editing the amount with the number left blank keeps 7002.
    const edited = await updateBillPayment(ctx, pay.id, {
      vendorId: v.id,
      date: d('2026-06-02'),
      method: 'check',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '30.00' }],
    });
    expect(edited.reference).toBe('7002');
    // ACH payments carry no check number.
    const ach = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-06-03'),
      method: 'ach',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '1.00' }],
    });
    expect(ach.reference).toBeNull();
    // To be printed: no number until printed.
    const queued = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-06-03'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '1.00' }],
    });
    expect(queued.reference).toBeNull();
  });

  it('I: two first item receipts saved at once share one 2050 accrual account', async () => {
    const [u2] = await db.insert(users).values({ email: 'r5-accrual@test.local', name: 'R5 A', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R5 Accrual Co', ownerId: u2.id });
    const c2: ServiceContext = { db, companyId: company.id, userId: u2.id };
    const a: Record<string, string> = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) a[r.code] = r.id;
    const [v] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Accrual V' }).returning();
    const item = await createItem(c2, { name: 'Accrual Widget', type: 'inventory', assetAccountId: a['1300'], cogsAccountId: a['5000'] } as never);
    const mk = () =>
      createItemReceipt(c2, { vendorId: v.id, date: d('2026-06-10'), lines: [{ itemId: item.id, quantity: 1, unitCost: '2.00' }] });
    await Promise.all([mk(), mk()]);
    const accruals = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, company.id), eq(accounts.code, '2050')));
    expect(accruals).toHaveLength(1);
  });

  it('J: text longer than its column is refused with a plain message', async () => {
    const v = await newVendor();
    await expectCode(
      createBill(ctx, { vendorId: v.id, billNumber: 'B'.repeat(150), date: d('2026-06-20'), lines: [{ accountId: acct['6300'], amount: '1.00' }] }),
      'VALIDATION',
    );
    await expectCode(createVendor(ctx, { displayName: 'V'.repeat(300) }), 'VALIDATION');
    await expectCode(
      createExpense(ctx, {
        payeeName: 'P'.repeat(300),
        date: d('2026-06-20'),
        method: 'cash',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6300'], amount: '1.00' }],
      }),
      'VALIDATION',
    );
  });
});
