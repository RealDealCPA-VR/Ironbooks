/**
 * Review round 4 — audit of round 3 (5b81be5): whole-day bounds, inventory valuation attribution,
 * FIFO / average-cost rounding and bank import. Each test failed before its fix.
 *
 *  A. Cash-basis balance sheet / P&L layered midnight-bounded adjustments on the whole-day accrual
 *     reports: a payment later on the as-of day left A/R at −$100.
 *  B. P&L by Class and Transaction Detail kept `<= midnight`, so they no longer tied to the P&L.
 *  C. Inventory valuation as-of attributed an expense-tab line coded to Inventory Asset to the
 *     bill's item (it scaled the account's net over the item lines).
 *  D. Re-importing a CSV staged before the formula-guard fix duplicated rows whose description
 *     carried the guard apostrophe ("'-ATM").
 *  E. Foreign bills: the scaled split moved a cent between the items.
 *  F. Average-cost sell-outs left the cents the 4dp average cannot represent on the GL
 *     (3000 units for $1000.00 left $0.10).
 *  G. FIFO: relief rounds per layer but inventoryValuation rounded the summed layer value.
 *  H. The valuation attribution bound one parameter per document in history (65535 cap).
 *  I. A CSV timestamp with a negative UTC offset landed on the next day.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers,
  vendors,
  items,
  bankAccounts,
  bankTransactions,
  journalEntries,
  journalEntryLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { balanceSheet, profitAndLoss } from './reports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { profitAndLossCashBasis } from './cashBasisReports';
import { profitAndLossByClass } from './classReports';
import { transactionDetail } from './reportsExtra';
import { createBill, voidBill } from './bills';
import { adjustInventory, inventoryValuation, inventoryValuationAsOf, inventoryValuationDetail } from './inventory';
import { importTransactions, parseCSV } from './import';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { receiveStock, consumeStock, fifoValuation } from './fifo';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-audit3b');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let vendorId: string;

async function newCustomer(name: string) {
  const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: name, taxable: false }).returning();
  return c.id;
}

async function newItem(name: string, assetAccountId: string): Promise<string> {
  const [row] = await db
    .insert(items)
    .values({
      companyId: ctx.companyId,
      name,
      type: 'inventory',
      quantityOnHand: '0',
      averageCost: '0',
      assetAccountId,
      incomeAccountId: acct['4000'],
    } as never)
    .returning();
  return row.id;
}

async function glBalance(accountId: string): Promise<string> {
  const rows = await db
    .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)));
  return (Math.round(rows.reduce((s, r) => s + Number(r.d ?? 0) - Number(r.c ?? 0), 0) * 100) / 100).toFixed(2);
}

async function newInventoryAccount(code: string, name: string): Promise<string> {
  return (await createAccount(ctx, { code, name, type: 'asset' as never, subtype: 'inventory' })).id;
}

describe('review4 audit of round 3 (bounds / inventory / bank import)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r4@audit3b.test', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'R4 Audit3b', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6000', 'Freight', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Vend' }).returning();
    vendorId = v.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('A: cash-basis balance sheet / P&L as of a day use the same whole-day bound as the accrual reports', async () => {
    const cust = await newCustomer('CashBasisCust');
    // Invoice on Jun 1, paid in full later on Jun 30 (a payment carrying a time of day — a bank-feed
    // match, an estimate conversion or any document created with `new Date()`).
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: new Date('2024-06-01'),
      lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '100.00', taxable: false }],
    } as never);
    await receivePayment(ctx, {
      customerId: cust,
      date: new Date('2024-06-30T15:00:00Z'),
      method: 'check',
      amount: '100.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    } as never);

    const asOf = new Date('2024-06-30'); // what /api/reports/balance-sheet-cash?asOf=2024-06-30 passes
    const accrual = await balanceSheet(ctx, asOf);
    expect(accrual.assets.find((l) => l.accountId === acct['1200'])?.amount ?? '0.00').toBe('0.00');

    const cash = await balanceSheetCashBasis(ctx, asOf);
    // Fully paid invoice: nothing on A/R on a cash basis either, and $100 of cash earnings.
    expect(cash.assets.find((l) => l.accountId === acct['1200'])?.amount ?? '0.00').toBe('0.00');
    expect(cash.retainedEarnings).toBe('100.00');
    expect(cash.balanced).toBe(true);

    // The cash P&L for June recognizes the payment made on Jun 30 (its accrual twin counts the day).
    const pl = await profitAndLossCashBasis(ctx, { from: new Date('2024-06-01'), to: asOf });
    expect(pl.netIncome).toBe('100.00');
    expect(pl.accrualNetIncome).toBe('100.00');
  });

  it('B: P&L by Class and Transaction Detail tie to the P&L for the same range (time-of-day posting on the "to" day)', async () => {
    const cust = await newCustomer('ClassCust');
    // e.g. an estimate converted to an invoice (estimates.ts converts with date: new Date()).
    await createInvoice(ctx, {
      customerId: cust,
      date: new Date('2024-07-31T10:30:00Z'),
      lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '250.00', taxable: false }],
    } as never);
    const range = { from: new Date('2024-07-01'), to: new Date('2024-07-31') };
    const pl = await profitAndLoss(ctx, range);
    expect(pl.netIncome).toBe('250.00');
    const byClass = await profitAndLossByClass(ctx, range);
    const classNet = Object.values(byClass.netByClass).reduce((s, v) => s + Number(v), 0);
    expect(classNet.toFixed(2)).toBe(pl.netIncome);

    const detail = await transactionDetail(ctx, { ...range, accountId: acct['4000'] });
    const credits = detail.rows.reduce((s, r) => s + Number(r.credit) - Number(r.debit), 0);
    expect(credits.toFixed(2)).toBe('250.00');
  });

  it('C: an expense-tab line coded to Inventory Asset is not attributed to the bill item (as-of = current valuation)', async () => {
    const id = await newItem('MixedBillWidget', acct['1300']);
    await createBill(ctx, {
      vendorId,
      date: new Date('2024-08-01'),
      lines: [
        { itemId: id, quantity: 10, unitCost: 10 }, // $100 of stock
        { accountId: acct['1300'], amount: '20.00', description: 'Freight coded to Inventory Asset (no item)' },
      ],
    } as never);
    const now = (await inventoryValuation(ctx)).items.find((r) => r.id === id)!;
    expect(now.totalValue).toBe('100.00');
    const asOf = (await inventoryValuationAsOf(ctx, new Date('2030-01-01'))).items.find((r) => r.id === id)!;
    expect(asOf.valueAsOf).toBe('100.00');
    const detail = await inventoryValuationDetail(ctx, { itemId: id });
    expect(detail.items[0].closingValue).toBe('100.00');
  });

  it('D: re-importing a CSV staged before round 3 does not duplicate rows whose description had the formula guard', async () => {
    const [bank] = await db
      .insert(bankAccounts)
      .values({ companyId: ctx.companyId, accountId: acct['1000'], bankName: 'Bank', accountNumber: '1' })
      .returning();
    // Row staged by the pre-round-3 importer (no fitId column): key = hash(date|raw description|amount|n).
    const date = new Date('2024-05-03T00:00:00.000Z');
    const rawDesc = "'-ATM WITHDRAWAL";
    const legacyFitId =
      'csv-hash:' + createHash('sha256').update(`${date.toISOString()}|${rawDesc}|-20.00|0`).digest('hex').slice(0, 32);
    await db.insert(bankTransactions).values({
      companyId: ctx.companyId,
      bankAccountId: bank.id,
      fitId: legacyFitId,
      date,
      description: rawDesc,
      amount: '-20.00',
      matched: false,
    } as never);
    // And one staged by a fitId column whose cell carried the guard.
    await db.insert(bankTransactions).values({
      companyId: ctx.companyId,
      bankAccountId: bank.id,
      fitId: "'-A77",
      date,
      description: 'Card',
      amount: '-5.00',
      matched: false,
    } as never);

    const plain = `Date,Description,Amount\n2024-05-03,${rawDesc},-20.00\n2024-05-03,New line,-7.00\n`;
    await importTransactions(ctx, {
      bankAccountId: bank.id,
      fileType: 'csv',
      content: plain,
      csvMapping: { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' },
    } as never);
    const withId = `Id,Date,Description,Amount\n'-A77,2024-05-03,Card,-5.00\n`;
    await importTransactions(ctx, {
      bankAccountId: bank.id,
      fileType: 'csv',
      content: withId,
      csvMapping: { fitIdCol: 'Id', dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' },
    } as never);
    const rows = await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, bank.id));
    // The two legacy rows stay single; only the genuinely new line is added.
    expect(rows.map((r) => r.amount).sort()).toEqual(['-20.00', '-5.00', '-7.00']);

    // Importing the same file again adds nothing (current keys).
    await importTransactions(ctx, {
      bankAccountId: bank.id,
      fileType: 'csv',
      content: plain,
      csvMapping: { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' },
    } as never);
    expect((await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, bank.id))).length).toBe(3);
  });

  it('E: foreign bill — each item as-of value equals the home amount its stock was received at', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.333333' });
    const [ev] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'EUR Vend', currency: 'EUR' } as never).returning();
    const a = await newItem('FxA', acct['1300']);
    const b = await newItem('FxB', acct['1300']);
    await createBill(ctx, {
      vendorId: ev.id,
      date: new Date('2024-09-01'),
      currency: 'EUR',
      exchangeRate: '1.333333',
      lines: [
        { itemId: a, quantity: 1, amount: '1.00' },
        { itemId: b, quantity: 1, amount: '1.00' },
        { accountId: acct['6000'], amount: '1.00' },
      ],
    } as never);
    const now = await inventoryValuation(ctx);
    const asOf = await inventoryValuationAsOf(ctx, new Date('2030-01-01'));
    const pick = (id: string) => ({
      now: now.items.find((r) => r.id === id)!.totalValue,
      asOf: asOf.items.find((r) => r.id === id)!.valueAsOf,
    });
    const pa = pick(a);
    const pb = pick(b);
    expect({ a: pa.asOf, b: pb.asOf }).toEqual({ a: pa.now, b: pb.now });
    expect(Number(pa.now) + Number(pb.now)).toBeCloseTo(2.67, 2);
  });

  it('F: average-cost sell-outs clear the inventory GL to exactly $0 (3000 units for $1000)', async () => {
    // 1. Bought on a bill, sold out on an invoice.
    const own = await newInventoryAccount('1320', 'Bulk Parts');
    const it1 = await newItem('BulkPart', own);
    await createBill(ctx, { vendorId, date: new Date('2024-10-01'), lines: [{ itemId: it1, quantity: 3000, amount: '1000.00' }] } as never);
    const cust = await newCustomer('BulkBuyer');
    // Partial sales first (telescoping), then the last units.
    await createInvoice(ctx, { customerId: cust, date: new Date('2024-10-02'), lines: [{ itemId: it1, quantity: 1000, rate: '1.00', taxable: false }] } as never);
    await createInvoice(ctx, { customerId: cust, date: new Date('2024-10-03'), lines: [{ itemId: it1, quantity: 2000, rate: '1.00', taxable: false }] } as never);
    const [after] = await db.select().from(items).where(eq(items.id, it1));
    expect(Number(after.quantityOnHand)).toBe(0);
    expect(await glBalance(own)).toBe('0.00');
    expect(after.valueRemainder).toBe('0.00');

    // 2. Received and removed with quantity adjustments.
    const own2 = await newInventoryAccount('1321', 'Bulk Parts 2');
    const it2 = await newItem('BulkPart2', own2);
    await adjustInventory(ctx, { itemId: it2, quantityChange: 3000, unitCost: '0.333333', date: new Date('2024-10-01') });
    expect(await glBalance(own2)).toBe('1000.00');
    await adjustInventory(ctx, { itemId: it2, quantityChange: -1200, date: new Date('2024-10-02') });
    await adjustInventory(ctx, { itemId: it2, quantityChange: -1800, date: new Date('2024-10-03') });
    expect(await glBalance(own2)).toBe('0.00');

    // 3. A voided bill takes its remainder with it, and a later cycle starts clean.
    const own3 = await newInventoryAccount('1322', 'Bulk Parts 3');
    const it3 = await newItem('BulkPart3', own3);
    const bill = await createBill(ctx, { vendorId, date: new Date('2024-10-01'), lines: [{ itemId: it3, quantity: 3000, amount: '1000.00' }] } as never);
    await voidBill(ctx, bill.id);
    const [voided] = await db.select().from(items).where(eq(items.id, it3));
    expect(Number(voided.quantityOnHand)).toBe(0);
    expect(voided.valueRemainder).toBe('0.00');
    expect(await glBalance(own3)).toBe('0.00');
    await createBill(ctx, { vendorId, date: new Date('2024-10-05'), lines: [{ itemId: it3, quantity: 300, amount: '100.00' }] } as never);
    await createBill(ctx, { vendorId, date: new Date('2024-10-06'), lines: [{ itemId: it3, quantity: 700, amount: '233.33' }] } as never);
    await createInvoice(ctx, { customerId: cust, date: new Date('2024-10-07'), lines: [{ itemId: it3, quantity: 1000, rate: '1.00', taxable: false }] } as never);
    expect(await glBalance(own3)).toBe('0.00');
  });

  it('G: FIFO — after a partial draw the inventory GL equals the FIFO valuation (per-layer cents)', async () => {
    const own = await newInventoryAccount('1330', 'FIFO Parts');
    const id = await newItem('FifoPart', own);
    await receiveStock(ctx, { itemId: id, quantity: 8, unitCost: '0.125', date: new Date('2024-11-01') }); // $1.00
    await receiveStock(ctx, { itemId: id, quantity: 3, unitCost: '3.3333', date: new Date('2024-11-02') }); // $10.00
    await consumeStock(ctx, { itemId: id, quantity: 7, date: new Date('2024-11-03') } as never);
    const gl = await glBalance(own);
    expect(gl).toBe('10.13');
    expect((await inventoryValuation(ctx)).items.find((r) => r.id === id)!.totalValue).toBe(gl);
    expect((await fifoValuation(ctx)).items.find((r) => r.itemId === id)!.totalValue).toBe(gl);
    expect((await inventoryValuationAsOf(ctx, new Date('2030-01-01'))).items.find((r) => r.id === id)!.valueAsOf).toBe(gl);
  });

  it('H: the valuation reports work with more than 65535 per-line COGS documents in history', async () => {
    const own = await newInventoryAccount('1340', 'Busy Parts');
    const id = await newItem('BusyPart', own);
    await adjustInventory(ctx, { itemId: id, quantityChange: 10, unitCost: '2.00', date: new Date('2024-12-01') });
    // 66,000 per-line COGS entries of distinct (synthetic) invoices on an inventory account: the
    // round-3 attribution bound one parameter per invoice and the query was refused. Bulk-loaded
    // with the ledger triggers off (balance sync / guards per row would take minutes); every
    // entry is balanced, and the reports read the lines themselves.
    const BATCH = 11_000;
    await db.execute(sql`SET session_replication_role = replica`);
    try {
      for (let start = 0; start < 66_000; start += BATCH) {
        await db.execute(sql`
        WITH e AS (
          INSERT INTO journal_entries (company_id, entry_number, date, description, status, source_ref, reference, created_by)
          SELECT ${ctx.companyId}::uuid, 5000000 + g, '2024-12-02'::timestamp, 'synthetic COGS', 'posted',
                 'invoice-cogs:' || gen_random_uuid()::text, 'cogs:0', ${ctx.userId}::uuid
          FROM generate_series(${start + 1}::int, ${start + BATCH}::int) AS g
          RETURNING id
        )
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
        SELECT id, ${acct['5000']}::uuid, 0.01, NULL FROM e
        UNION ALL
        SELECT id, ${own}::uuid, NULL, 0.01 FROM e
      `);
      }
    } finally {
      await db.execute(sql`SET session_replication_role = origin`);
    }
    const [{ n }] = (
      await db.execute(sql`SELECT count(*)::int AS n FROM journal_entries WHERE source_ref LIKE 'invoice-cogs:%' AND company_id = ${ctx.companyId}::uuid`)
    ).rows as unknown as Array<{ n: number }>;
    expect(n).toBeGreaterThan(65_535);
    // Reopen the company file: the app gives never-analyzed tables planner statistics on open
    // (lib/db/plannerStats.ts). Without them PGlite plans the line scan as a quadratic nested
    // loop (~90 s here); with them the reports below take well under a second.
    await closeDb(TEST_DIR);
    db = await getDb(TEST_DIR);
    ctx = { ...ctx, db };
    const started = Date.now();
    const asOf = await inventoryValuationAsOf(ctx, new Date('2030-01-01'));
    // The synthetic entries name no invoice line, so they stay unattributed; the item keeps its $20.
    expect(asOf.items.find((r) => r.id === id)!.valueAsOf).toBe('20.00');
    const detail = await inventoryValuationDetail(ctx, { itemId: id });
    expect(detail.items[0].closingValue).toBe('20.00');
    // Both reports together; without statistics each took ~90 s on this data.
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 400_000);

  it('I: CSV timestamps land on the calendar day the bank printed', () => {
    const rows = parseCSV(
      'Date,Description,Amount\n' +
        '2024-01-31T23:30:00-05:00,Late card swipe,-12.00\n' +
        '2024-01-31T01:30:00+09:00,Early card swipe,-1.00\n' +
        'Jan 31 2024 23:30:00 -0500,Text date with zone,-2.00\n' +
        '01-31-2024,Dashed US date,-3.00\n',
      { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' },
    );
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual(['2024-01-31', '2024-01-31', '2024-01-31', '2024-01-31']);
  });
});
