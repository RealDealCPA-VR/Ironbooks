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
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  bills,
  companies,
  inventoryLayers,
  items,
  journalEntries,
  journalEntryLines,
  purchaseOrderLines,
  purchaseOrders,
  taxRates,
  users,
  vendors,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createItem } from './items';
import { createBill, getBill, updateBill } from './bills';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { payBills, updateBillPayment } from './billPayments';
import { createVendor } from './vendors';
import { createPurchaseOrder, convertToBill, updateStatus } from './purchaseOrders';
import { checkPrintData } from './printQueue';
import { generate1099NecFile } from './form1099Xml';
import { vendor1099Report, vendor1099Worksheet } from './statements';
import { createManualEntry } from './journal';
import { createExpense } from './expenses';
import { createItemReceipt, updateItemReceipt } from './itemReceipts';
import { enterBillForReceivedItems } from './receiving';
import { allocateLandedCost } from './landedCost';
import { upsertCurrency, setBaseCurrency } from './currencies';
import { payCreditCard, payPayrollLiabilities, paySalesTax, paySalesTaxScreen } from './liabilityPayments';
import { createTaxRate, updateTaxRate } from './salesTax';
import { setComponents } from './combinedTax';
import { createVendorCredit, applyToBill, unapplyFromBill, refundVendorCredit, voidVendorCredit } from './vendorCredits';

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

  it('K: voiding a purchase order while it is being converted to a bill never leaves a void PO with a bill', async () => {
    const v = await newVendor();
    for (let i = 0; i < 3; i++) {
      const po = await createPurchaseOrder(ctx, {
        vendorId: v.id,
        date: d('2026-07-01'),
        lines: [{ accountId: acct['6300'], quantity: 2, rate: '10.00' }],
      });
      const [conv, vd] = await Promise.allSettled([convertToBill(ctx, po.id), updateStatus(ctx, po.id, 'void')]);
      const [row] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id));
      const [line] = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
      if (conv.status === 'fulfilled') {
        // The bill exists: the PO must not be void (its quantities are billed).
        expect(row.status).not.toBe('void');
        expect(vd.status).toBe('rejected');
      } else {
        expect(Number(line.quantityBilled)).toBe(0);
      }
    }
  });

  it('L: a bill payment check stub shows what the check pays on each bill (discounts apart)', async () => {
    const v = await newVendor();
    const b1 = await createBill(ctx, { vendorId: v.id, billNumber: 'L-1', date: d('2026-07-05'), lines: [{ accountId: acct['6300'], amount: '1000.00' }] });
    const b2 = await createBill(ctx, { vendorId: v.id, billNumber: 'L-2', date: d('2026-07-05'), lines: [{ accountId: acct['6300'], amount: '300.00' }] });
    const pay = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-07-08'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      discountAccountId: acct['6300'],
      applications: [
        { billId: b1.id, amountApplied: '980.00', discountTaken: '20.00' },
        { billId: b2.id, amountApplied: '300.00' },
      ],
    });
    const data = await checkPrintData(ctx, 'bill_payment', pay.id);
    expect(data.amount).toBe('1280.00');
    const byBill = Object.fromEntries(data.voucher.map((l) => [l.account, l]));
    expect(byBill['Bill L-1'].amount).toBe('980.00');
    expect(byBill['Bill L-1'].description).toContain('discount 20.00');
    expect(byBill['Bill L-2'].amount).toBe('300.00');
    const total = data.voucher.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0) / 100;
    expect(total.toFixed(2)).toBe(data.amount);
  });

  it('N: the 1099-NEC e-file carries the payer TIN and address and the recipient address', async () => {
    const [co] = await db.select().from(companies).where(eq(companies.id, ctx.companyId));
    await db
      .update(companies)
      .set({
        settings: {
          ...((co.settings ?? {}) as Record<string, unknown>),
          legalName: 'R5 Purchases Company LLC',
          ein: '98-7654321',
          addressLine1: '10 Payer Way',
          city: 'Springfield',
          state: 'IL',
          zip: '62701',
          phone: '217-555-0100',
        },
      })
      .where(eq(companies.id, ctx.companyId));
    const v = await newVendor({ is1099: true, taxId: '12-3456789', address: { line1: '5 Contractor Rd', city: 'Peoria', state: 'IL', zip: '61602' } });
    await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-08-01'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '2500.00' }],
    });
    const xml = await generate1099NecFile(ctx, { year: 2026 });
    const payer = xml.slice(xml.indexOf('<Payer>'), xml.indexOf('</Payer>'));
    expect(payer).toContain('<BusinessName>R5 Purchases Company LLC</BusinessName>');
    expect(payer).toContain('<TIN>98-7654321</TIN>');
    expect(payer).toContain('<AddressLine>10 Payer Way</AddressLine>');
    expect(payer).toContain('<AddressLine>Springfield, IL 62701</AddressLine>');
    const rec = xml.slice(xml.indexOf(`<Name>${v.displayName}</Name>`));
    expect(rec.slice(0, rec.indexOf('</PayeeInfo>'))).toContain('<AddressLine>5 Contractor Rd</AddressLine>');
  });

  it('O: Pay Sales Tax "due through" that is not a real day is a 400', async () => {
    await expectCode(paySalesTaxScreen(ctx, { dueThrough: '2026-13-01' }), 'VALIDATION');
    await expectCode(paySalesTaxScreen(ctx, { dueThrough: '2026-02-30' }), 'VALIDATION');
    const ok = await paySalesTaxScreen(ctx, { dueThrough: '2026-06-30' });
    expect(ok.dueThrough).toBe('2026-06-30');
  });

  it('P: voiding a refunded vendor credit says to void the refund (it was never applied)', async () => {
    const v = await newVendor();
    const credit = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-08-10'), lines: [{ accountId: acct['6300'], amount: '15.00' }] });
    await refundVendorCredit(ctx, { vendorCreditId: credit.id, bankAccountId: acct['1000'], amount: '15.00', date: d('2026-08-11') });
    const err = (await voidVendorCredit(ctx, credit.id).catch((e) => e)) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/refund/i);
    expect(err.message).not.toMatch(/applied to a bill/i);
  });

  it('Q: an item receipt costed beyond 4 decimals posts what its stored cost values (GL == stock, void clears)', async () => {
    const { receiveStock } = await import('./fifo');
    const v = await newVendor();
    const invAcct = (await createAccount(ctx, { code: '1350', name: 'Inv Q', type: 'asset' as never, subtype: 'inventory' })).id;
    const fifo = await createItem(ctx, { name: `Fifo Q ${++seq}`, type: 'inventory', assetAccountId: invAcct, cogsAccountId: acct['5000'] } as never);
    await receiveStock(ctx, { itemId: fifo.id, quantity: 1, unitCost: '1.00', date: d('2026-08-20') });
    const avg = await createItem(ctx, { name: `Avg Q ${++seq}`, type: 'inventory', assetAccountId: invAcct, cogsAccountId: acct['5000'] } as never);
    const before = await glBalance(invAcct);
    const receipt = await createItemReceipt(ctx, {
      vendorId: v.id,
      date: d('2026-08-21'),
      lines: [
        { itemId: fifo.id, quantity: 1000, unitCost: '0.33333' },
        { itemId: avg.id, quantity: 3000, unitCost: '0.333333' },
      ],
    });
    const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.sourceRef, `item_receipt:${receipt.id}`));
    const layerValue = layers.reduce((s, l) => s + Math.round(Number(l.quantityRemaining) * Number(l.unitCost) * 100), 0) / 100;
    const [avgRow] = await db.select().from(items).where(eq(items.id, avg.id));
    const avgValue = Math.round(Number(avgRow.quantityOnHand) * Number(avgRow.averageCost) * 100) / 100 + Number(avgRow.valueRemainder ?? 0);
    const gained = Number(await glBalance(invAcct)) - Number(before);
    expect(gained.toFixed(2)).toBe((layerValue + avgValue).toFixed(2));
    // The receipt line shows the cost it was valued at.
    expect(receipt.lines[0].unitCost).toBe('0.3333');
    expect(receipt.lines[0].amount).toBe('333.30');
    const { voidItemReceipt } = await import('./itemReceipts');
    await voidItemReceipt(ctx, receipt.id);
    expect(await glBalance(invAcct)).toBe(before);
  });

  it('R: purchase documents are looked up by index, not by scanning every line in the file', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const lookups: Array<[string, ReturnType<typeof sql>]> = [
      ['bill_lines.bill_id', sql`SELECT * FROM bill_lines WHERE bill_id = ${id}`],
      ['bill_payment_applications.bill_id', sql`SELECT * FROM bill_payment_applications WHERE bill_id = ${id}`],
      ['bill_payment_applications.bill_payment_id', sql`SELECT * FROM bill_payment_applications WHERE bill_payment_id = ${id}`],
      ['bills(company, vendor)', sql`SELECT * FROM bills WHERE company_id = ${id} AND vendor_id = ${id}`],
      ['bill_payments(company, account)', sql`SELECT * FROM bill_payments WHERE company_id = ${id} AND payment_account_id = ${id}`],
      ['expense_lines.expense_id', sql`SELECT * FROM expense_lines WHERE expense_id = ${id}`],
      ['expenses(company, account)', sql`SELECT * FROM expenses WHERE company_id = ${id} AND payment_account_id = ${id}`],
      ['vendor_credit_lines.vendor_credit_id', sql`SELECT * FROM vendor_credit_lines WHERE vendor_credit_id = ${id}`],
      ['item_receipt_lines.item_receipt_id', sql`SELECT * FROM item_receipt_lines WHERE item_receipt_id = ${id}`],
      ['purchase_order_lines.purchase_order_id', sql`SELECT * FROM purchase_order_lines WHERE purchase_order_id = ${id}`],
    ];
    const seqScans: string[] = [];
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      for (const [label, q] of lookups) {
        const res = (await tx.execute(sql`EXPLAIN ${q}`)) as unknown as { rows: Array<Record<string, string>> };
        const plan = res.rows.map((r) => Object.values(r).join(' ')).join('\n');
        if (/Seq Scan/.test(plan)) seqScans.push(label);
      }
    });
    expect(seqScans).toEqual([]);
  });

  it('S: a double-submitted bill with a vendor reference number is caught as a duplicate', async () => {
    const v = await newVendor();
    const input = {
      vendorId: v.id,
      billNumber: 'DUP-77',
      date: d('2026-09-01'),
      checkDuplicateNumber: true,
      lines: [{ accountId: acct['6300'], amount: '42.00' }],
    };
    const res = await Promise.allSettled([createBill(ctx, input), createBill(ctx, input), createBill(ctx, input), createBill(ctx, input)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ServiceError);
    expect((rejected.reason as ServiceError).details).toMatchObject({ duplicateNumber: true });
    const rows = await db.select().from(bills).where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, v.id)));
    expect(rows).toHaveLength(1);
  });

  it('T: a memo / number edit of a bill keeps its entry and stock, even when paid or its items were sold', async () => {
    const v = await newVendor({ terms: 'net_30' });
    const item = await newInventoryItem('Memo T');
    const bill = await createBill(ctx, {
      vendorId: v.id,
      billNumber: 'T-1',
      date: d('2026-09-10'),
      memo: 'first',
      lines: [
        { itemId: item.id, quantity: 10, unitCost: '4.00' },
        { accountId: acct['6300'], amount: '20.00', description: 'Shipping' },
      ],
    });
    const cust = (await createCustomer(ctx, { displayName: `T cust ${++seq}` })).id;
    await createInvoice(ctx, { customerId: cust, date: d('2026-09-11'), lines: [{ itemId: item.id, quantity: 3, rate: '9.00' }] } as never);
    await payBills(ctx, { vendorId: v.id, date: d('2026-09-12'), method: 'ach', paymentAccountId: acct['1000'], applications: [{ billId: bill.id, amountApplied: '25.00' }] });
    const entriesBefore = (await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    const sameLines = [
      { itemId: item.id, quantity: 10, unitCost: '4.00' },
      { accountId: acct['6300'], amount: '20.00', description: 'Freight (fixed typo)' },
    ];
    const edited = await updateBill(ctx, bill.id, { vendorId: v.id, billNumber: 'T-1A', date: d('2026-09-10'), memo: 'second', lines: sameLines });
    expect(edited.postedEntryId).toBe(bill.postedEntryId);
    expect(edited.memo).toBe('second');
    expect(edited.billNumber).toBe('T-1A');
    expect(edited.amountPaid).toBe('25.00');
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, bill.postedEntryId!));
    expect(entry.status).toBe('posted');
    expect(entry.reference).toBe('T-1A');
    const got = await getBill(ctx, bill.id);
    expect(got.lines[1].description).toBe('Freight (fixed typo)');
    const [itemRow] = await db.select().from(items).where(eq(items.id, item.id));
    expect(Number(itemRow.quantityOnHand)).toBe(7);
    // Re-saving it unchanged again is a no-op for the ledger.
    await updateBill(ctx, bill.id, { vendorId: v.id, billNumber: 'T-1A', date: d('2026-09-10'), memo: 'second', lines: sameLines });
    const entriesAfter = (await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    expect(entriesAfter).toBe(entriesBefore);
    // Changing an amount on the paid bill is still refused.
    await expectCode(
      updateBill(ctx, bill.id, { vendorId: v.id, billNumber: 'T-1A', date: d('2026-09-10'), lines: [sameLines[0], { ...sameLines[1], amount: '21.00' }] }),
      'CONFLICT',
    );
  });

  it('U: a reference / memo edit of an item receipt whose items were sold keeps its entry and stock', async () => {
    const v = await newVendor();
    const item = await newInventoryItem('Memo U');
    const receipt = await createItemReceipt(ctx, {
      vendorId: v.id,
      date: d('2026-09-15'),
      reference: 'PS-1',
      lines: [{ itemId: item.id, quantity: 10, unitCost: '3.00', description: 'Widgets' }],
    });
    const cust = (await createCustomer(ctx, { displayName: `U cust ${++seq}` })).id;
    await createInvoice(ctx, { customerId: cust, date: d('2026-09-16'), lines: [{ itemId: item.id, quantity: 4, rate: '9.00' }] } as never);
    const edited = await updateItemReceipt(ctx, receipt.id, {
      vendorId: v.id,
      date: d('2026-09-15'),
      reference: 'PS-1B',
      memo: 'packing slip corrected',
      lines: [{ itemId: item.id, quantity: 10, unitCost: '3.00', description: 'Blue widgets' }],
    });
    expect(edited.postedEntryId).toBe(receipt.postedEntryId);
    expect(edited.reference).toBe('PS-1B');
    expect(edited.lines[0].description).toBe('Blue widgets');
    const [itemRow] = await db.select().from(items).where(eq(items.id, item.id));
    expect(Number(itemRow.quantityOnHand)).toBe(6);
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, receipt.postedEntryId!));
    expect(entry.status).toBe('posted');
    expect(entry.reference).toBe('PS-1B');
  });

  it('V: a memo edit of a bill / receipt in a closed period still needs the closing-date password', async () => {
    const [u3] = await db.insert(users).values({ email: 'r5-closed@test.local', name: 'R5 C', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R5 Closed Co', ownerId: u3.id });
    const c3: ServiceContext = { db, companyId: company.id, userId: u3.id };
    const a: Record<string, string> = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) a[r.code] = r.id;
    const [v] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Closed V' }).returning();
    const item = await createItem(c3, { name: 'Closed Widget', type: 'inventory', assetAccountId: a['1300'], cogsAccountId: a['5000'] } as never);
    const bill = await createBill(c3, { vendorId: v.id, date: d('2026-01-10'), lines: [{ accountId: a['6300'], amount: '9.00' }] });
    const receipt = await createItemReceipt(c3, { vendorId: v.id, date: d('2026-01-11'), lines: [{ itemId: item.id, quantity: 1, unitCost: '2.00' }] });
    const { setClosingDate } = await import('./company');
    await setClosingDate(c3, { closingDate: '2026-01-31', password: 'close-pw' } as never);
    const billEdit = { vendorId: v.id, date: d('2026-01-10'), memo: 'late memo', lines: [{ accountId: a['6300'], amount: '9.00' }] };
    const receiptEdit = { vendorId: v.id, date: d('2026-01-11'), memo: 'late memo', lines: [{ itemId: item.id, quantity: 1, unitCost: '2.00' }] };
    await expectCode(updateBill(c3, bill.id, billEdit), 'PERIOD_CLOSED');
    await expectCode(updateItemReceipt(c3, receipt.id, receiptEdit), 'PERIOD_CLOSED');
    const over: ServiceContext = { ...c3, closingDateOverride: true };
    expect((await updateBill(over, bill.id, billEdit)).memo).toBe('late memo');
    expect((await updateItemReceipt(over, receipt.id, receiptEdit)).memo).toBe('late memo');
  });

  it('W: 1099s count General Journal amounts owed that Pay Bills paid', async () => {
    const v = await newVendor({ is1099: true, taxId: '11-2223333' });
    // Opening balance owed to the contractor, entered as a General Journal amount (QB conversions).
    const je = await createManualEntry(ctx, {
      date: d('2025-02-01'),
      description: 'Opening balance owed',
      lines: [
        { accountId: acct['6300'], debit: '700.00' },
        { accountId: acct['2000'], credit: '700.00', entityType: 'vendor', entityId: v.id },
      ],
    } as never);
    const [apLine] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, je.id), eq(journalEntryLines.accountId, acct['2000'])));
    await payBills(ctx, {
      vendorId: v.id,
      date: d('2025-02-15'),
      method: 'check',
      paymentAccountId: acct['1000'],
      applications: [],
      journalItems: [{ journalLineId: apLine.id, amount: '700.00' }],
    });
    const row = (await vendor1099Report(ctx, { year: 2025 })).find((r) => r.vendorId === v.id);
    expect(row?.total ?? 'omitted').toBe('700.00');
    const wr = (await vendor1099Worksheet(ctx, { year: 2025 })).rows.find((r) => r.vendorId === v.id);
    expect(wr?.nec1 ?? 'omitted').toBe('700.00');
  });

  it('X: a bill cannot be paid before its date (A/P aging as of that day must match the A/P account)', async () => {
    const v = await newVendor();
    const bill = await createBill(ctx, { vendorId: v.id, billNumber: 'X-1', date: d('2026-10-10'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    await expectCode(
      payBills(ctx, { vendorId: v.id, date: d('2026-10-05'), method: 'ach', paymentAccountId: acct['1000'], applications: [{ billId: bill.id, amountApplied: '100.00' }] }),
      'VALIDATION',
    );
    // Same day is fine; an edit cannot move it before the bill either.
    const pay = await payBills(ctx, { vendorId: v.id, date: d('2026-10-10'), method: 'ach', paymentAccountId: acct['1000'], applications: [{ billId: bill.id, amountApplied: '40.00' }] });
    await expectCode(
      updateBillPayment(ctx, pay.id, { vendorId: v.id, date: d('2026-10-01'), method: 'ach', paymentAccountId: acct['1000'], applications: [{ billId: bill.id, amountApplied: '40.00' }] }),
      'VALIDATION',
    );
    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(row.balanceDue).toBe('60.00');
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
