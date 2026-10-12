/**
 * Randomized property test: the books can never go out of balance.
 *
 * A seeded PRNG (mulberry32 — deterministic, no dependencies) drives ~300 operations through
 * the PUBLIC services: inventory + sales-tax invoices, customer payments (partial / full /
 * overpayment / void), deposits, bills, bill payments, vendor credits, credit memos (with
 * restock), transfers, manual journal entries (edit / reverse / void), payroll (run / void),
 * document voids — plus occasional raw-SQL tampering attempts that the database must refuse.
 *
 * After EVERY step it asserts, from raw SQL as well as from the report services:
 *   1. trial balance: total debits == total credits (and every posted entry balances);
 *   2. accrual balance sheet balances;
 *   3. cash-basis balance sheet balances;
 *   4. every accounts.balance equals its ledger-derived balance.
 *
 * Rejected operations (ServiceError — e.g. paying a voided invoice) are fine: they must simply
 * leave the invariants intact. Any non-ServiceError failure fails the test.
 *
 * Re-run a failing sequence with LEDGER_PROPERTY_SEED=<seed> (printed on failure).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { allocate, Money, toAmountString } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createItem } from './items';
import { createTaxAgency, createTaxRate } from './salesTax';
import { createInvoice, voidInvoice } from './invoices';
import { receivePayment, voidPayment } from './payments';
import { createDeposit, listUndepositedPayments, voidDeposit } from './deposits';
import { createBill, voidBill } from './bills';
import { payBills, voidBillPayment } from './billPayments';
import { applyToBill, createVendorCredit, voidVendorCredit } from './vendorCredits';
import { applyToInvoice, createCreditMemo, voidCreditMemo } from './creditMemos';
import { createTransfer } from './transfers';
import { createManualEntry, reverseEntry, updateEntry, voidEntry } from './journal';
import { createEmployee, runPaycheck, voidPaycheck } from './payroll';
import { balanceSheet, trialBalance } from './reports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { booksInBalance } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ledger-property');
const SEED = Number(process.env.LEDGER_PROPERTY_SEED ?? 20261010);
const STEPS = Number(process.env.LEDGER_PROPERTY_STEPS ?? 300);

/** mulberry32: tiny, fast, deterministic 32-bit PRNG. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const ids = {
  customers: [] as string[],
  vendors: [] as string[],
  inventoryItems: [] as string[],
  serviceItems: [] as string[],
  taxRates: [] as string[],
  invoices: [] as Array<{ id: string; total: string }>,
  payments: [] as string[],
  deposits: [] as string[],
  bills: [] as Array<{ id: string; total: string }>,
  billPayments: [] as string[],
  vendorCredits: [] as string[],
  creditMemos: [] as string[],
  journal: [] as string[],
  employees: [] as string[],
  paychecks: [] as string[],
};

describe('ledger property: random operations never unbalance the books', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'property@test.local', name: 'Property', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'Property Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
    for (const r of rows) acct[r.code] = r.id;

    for (let i = 0; i < 3; i++) {
      ids.customers.push((await createCustomer(ctx, { displayName: `Customer ${i}` })).id);
      ids.vendors.push((await createVendor(ctx, { displayName: `Vendor ${i}` })).id);
    }
    const agency = await createTaxAgency(ctx, { name: 'State DOR', liabilityAccountId: acct['2200'] });
    ids.taxRates.push((await createTaxRate(ctx, { name: 'State 8.25%', rate: '0.0825', agencyId: agency.id })).id);
    ids.taxRates.push((await createTaxRate(ctx, { name: 'City 2.5%', rate: '0.025', agencyId: agency.id })).id);
    for (let i = 0; i < 2; i++) {
      const inv = await createItem(ctx, {
        name: `Widget ${i}`,
        type: 'inventory',
        salesPrice: i === 0 ? '19.99' : '7.35',
        purchaseCost: i === 0 ? '8.13' : '2.71',
        incomeAccountId: acct['4000'],
        expenseAccountId: acct['5000'],
        assetAccountId: acct['1300'],
        taxable: true,
      });
      ids.inventoryItems.push(inv.id);
    }
    ids.serviceItems.push(
      (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: '125.00', incomeAccountId: acct['4100'], taxable: false })).id,
    );
    ids.employees.push(
      (await createEmployee(ctx, { firstName: 'Pat', lastName: 'Payroll', payType: 'hourly', payRate: '23.17' })).id,
    );
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it(`stays balanced across ${STEPS} random operations (seed ${SEED})`, async () => {
    const rand = mulberry32(SEED);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rand() * xs.length)] : undefined);
    const money = (lo: number, hi: number) => toAmountString((lo * 100 + int(0, (hi - lo) * 100)) / 100);
    const day = () => new Date(Date.UTC(2026, 0, 1 + int(0, 270)));

    const ops: Record<string, () => Promise<unknown>> = {
      ownerContribution: () => {
        const amt = money(100, 5000);
        return createManualEntry(ctx, {
          date: day(),
          description: 'Owner contribution',
          lines: [
            { accountId: acct['1000'], debit: amt },
            { accountId: acct['3000'], credit: amt },
          ],
        });
      },
      buyInventory: () =>
        createBill(ctx, {
          vendorId: pick(ids.vendors)!,
          date: day(),
          lines: [{ itemId: pick(ids.inventoryItems)!, quantity: int(1, 20), unitCost: money(1, 15) }],
        }).then((b) => ids.bills.push({ id: b.id, total: String(b.total) })),
      expenseBill: () =>
        createBill(ctx, {
          vendorId: pick(ids.vendors)!,
          date: day(),
          lines: [
            { accountId: pick([acct['6200'], acct['6300'], acct['6600']])!, amount: money(5, 900) },
            ...(rand() < 0.4 ? [{ accountId: acct['6400'], amount: money(1, 300) }] : []),
          ],
        }).then((b) => ids.bills.push({ id: b.id, total: String(b.total) })),
      invoice: () =>
        createInvoice(ctx, {
          customerId: pick(ids.customers)!,
          date: day(),
          taxRateId: rand() < 0.6 ? pick(ids.taxRates) : null,
          discount: rand() < 0.2 ? money(1, 10) : null,
          lines: [
            ...(rand() < 0.6 ? [{ itemId: pick(ids.inventoryItems)!, quantity: int(1, 4), rate: money(5, 40) }] : []),
            { itemId: ids.serviceItems[0], quantity: int(1, 3), rate: money(10, 300), taxable: rand() < 0.5 },
          ],
        }).then((inv) => ids.invoices.push({ id: inv.id, total: String(inv.total) })),
      receivePayment: async () => {
        const inv = pick(ids.invoices);
        if (!inv) return;
        const mode = rand();
        // Usually against the CURRENT balance due (occasionally the stale total, which the
        // service must reject): partial, exact, or overpayment (leaves an unapplied credit).
        const due = rand() < 0.85 ? await openBalance('invoices', inv.id) : inv.total;
        if (Money.isZero(due)) return;
        const applied = mode < 0.3 ? toAmountString(Money.round2(Money.mul(due, '0.5'))) : due;
        const amount = mode > 0.85 ? toAmountString(Money.add(applied, money(1, 50))) : applied;
        const p = await receivePayment(ctx, {
          customerId: (await invoiceCustomer(inv.id))!,
          date: day(),
          method: 'check',
          amount,
          depositAccountId: rand() < 0.3 ? acct['1000'] : null,
          applications: [{ invoiceId: inv.id, amountApplied: applied }],
        });
        ids.payments.push(p.payment.id);
      },
      voidPayment: async () => {
        const p = pick(ids.payments);
        if (p) await voidPayment(ctx, p);
      },
      deposit: async () => {
        const und = await listUndepositedPayments(ctx);
        const chosen = und.filter(() => rand() < 0.7);
        if (!chosen.length) return;
        const d = await createDeposit(ctx, {
          depositAccountId: acct['1000'],
          date: day(),
          paymentIds: chosen.filter((c) => c.kind === 'payment').map((c) => c.id),
          salesReceiptIds: chosen.filter((c) => c.kind === 'sales_receipt').map((c) => c.id),
          extraLines: rand() < 0.2 ? [{ accountId: acct['3000'], amount: money(1, 100) }] : [],
        });
        ids.deposits.push(d.id);
      },
      voidDeposit: async () => {
        const d = pick(ids.deposits);
        if (d) await voidDeposit(ctx, d);
      },
      payBill: async () => {
        const b = pick(ids.bills);
        if (!b) return;
        const due = rand() < 0.85 ? await openBalance('bills', b.id) : b.total;
        if (Money.isZero(due)) return;
        const amt = rand() < 0.4 ? toAmountString(Money.round2(Money.mul(due, '0.3'))) : due;
        const bp = await payBills(ctx, {
          vendorId: (await billVendor(b.id))!,
          date: day(),
          method: 'check',
          paymentAccountId: rand() < 0.8 ? acct['1000'] : acct['2100'],
          applications: [{ billId: b.id, amountApplied: amt }],
        });
        ids.billPayments.push(bp.id);
      },
      voidBillPayment: async () => {
        const bp = pick(ids.billPayments);
        if (bp) await voidBillPayment(ctx, bp);
      },
      vendorCredit: async () => {
        const b = pick(ids.bills);
        const vendorId = b ? (await billVendor(b.id))! : pick(ids.vendors)!;
        const vc = await createVendorCredit(ctx, {
          vendorId,
          date: day(),
          lines: [{ accountId: pick([acct['6300'], acct['6600']])!, amount: money(1, 80) }],
        });
        ids.vendorCredits.push(vc.id);
        if (b && rand() < 0.7) await applyToBill(ctx, { vendorCreditId: vc.id, billId: b.id, amount: money(1, 20) });
      },
      voidVendorCredit: async () => {
        const vc = pick(ids.vendorCredits);
        if (vc) await voidVendorCredit(ctx, vc);
      },
      creditMemo: async () => {
        const inv = pick(ids.invoices);
        const customerId = inv ? (await invoiceCustomer(inv.id))! : pick(ids.customers)!;
        const cm = await createCreditMemo(ctx, {
          customerId,
          date: day(),
          taxRateId: rand() < 0.5 ? pick(ids.taxRates) : null,
          lines: [
            rand() < 0.5
              ? { itemId: pick(ids.inventoryItems)!, quantity: 1, rate: money(5, 30), restock: rand() < 0.7 }
              : { itemId: ids.serviceItems[0], quantity: 1, rate: money(5, 60), taxable: false },
          ],
        });
        ids.creditMemos.push(cm.id);
        if (inv && rand() < 0.7) await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: money(1, 15) });
      },
      voidCreditMemo: async () => {
        const cm = pick(ids.creditMemos);
        if (cm) await voidCreditMemo(ctx, cm);
      },
      transfer: () =>
        rand() < 0.5
          ? createTransfer(ctx, { date: day(), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: money(1, 400) })
          : createTransfer(ctx, { date: day(), fromAccountId: acct['1010'], toAccountId: acct['1000'], amount: money(1, 400) }),
      journalEntry: async () => {
        // A random multi-line entry whose sides are penny-allocated (never floats).
        const total = money(1, 2000);
        const debitAccts = [pick([acct['6000'], acct['6100'], acct['1500']])!, acct['6700']];
        const creditAccts = [pick([acct['1000'], acct['2100']])!];
        const parts = allocate(total, debitAccts.map(() => int(1, 9)));
        const e = await createManualEntry(ctx, {
          date: day(),
          description: 'Random JE',
          lines: [
            ...debitAccts.map((a, i) => ({ accountId: a, debit: parts[i].toFixed(2) })).filter((l) => l.debit !== '0.00'),
            ...creditAccts.map((a) => ({ accountId: a, credit: total })),
          ],
        });
        ids.journal.push(e.id);
      },
      editJournal: async () => {
        const id = pick(ids.journal);
        if (!id) return;
        const amt = money(1, 500);
        const e = await updateEntry(ctx, id, {
          date: day(),
          description: 'Edited JE',
          lines: [
            { accountId: acct['6000'], debit: amt },
            { accountId: acct['1000'], credit: amt },
          ],
        });
        ids.journal.push((e as { id: string }).id);
      },
      reverseJournal: async () => {
        const id = pick(ids.journal);
        if (id) await reverseEntry(ctx, id);
      },
      voidJournal: async () => {
        const id = pick(ids.journal);
        if (id) await voidEntry(ctx, id);
      },
      voidInvoice: async () => {
        const inv = pick(ids.invoices);
        if (inv) await voidInvoice(ctx, inv.id);
      },
      voidBill: async () => {
        const b = pick(ids.bills);
        if (b) await voidBill(ctx, b.id);
      },
      payroll: async () => {
        const pc = await runPaycheck(ctx, {
          employeeId: ids.employees[0],
          payDate: day(),
          grossPay: money(200, 2500),
          taxes: rand() < 0.5 ? undefined : [{ kind: 'tax', name: 'Federal Income Tax', amount: money(1, 100) }],
        } as Parameters<typeof runPaycheck>[1]);
        ids.paychecks.push(pc.id);
      },
      voidPaycheck: async () => {
        const pc = pick(ids.paychecks);
        if (pc) await voidPaycheck(ctx, pc);
      },
      tamper: () => tamperAttempt(rand),
    };

    // Weighted operation mix: creation-heavy, with a steady stream of voids / edits.
    const weights: Array<[string, number]> = [
      ['ownerContribution', 4], ['buyInventory', 8], ['expenseBill', 6], ['invoice', 12],
      ['receivePayment', 10], ['voidPayment', 3], ['deposit', 5], ['voidDeposit', 2],
      ['payBill', 7], ['voidBillPayment', 2], ['vendorCredit', 4], ['voidVendorCredit', 1],
      ['creditMemo', 4], ['voidCreditMemo', 1], ['transfer', 4], ['journalEntry', 6],
      ['editJournal', 2], ['reverseJournal', 2], ['voidJournal', 2], ['voidInvoice', 2],
      ['voidBill', 2], ['payroll', 3], ['voidPaycheck', 1], ['tamper', 3],
    ];
    const totalWeight = weights.reduce((a, [, w]) => a + w, 0);
    const chooseOp = () => {
      let r = rand() * totalWeight;
      for (const [name, w] of weights) if ((r -= w) < 0) return name;
      return weights[0][0];
    };

    const succeeded: Record<string, number> = {};
    const rejected: Record<string, number> = {};
    for (let step = 1; step <= STEPS; step++) {
      const op = chooseOp();
      try {
        await ops[op]();
        succeeded[op] = (succeeded[op] ?? 0) + 1;
      } catch (err) {
        // A legitimate service must never trip a database ledger guard (sqlstate BK00x):
        // that would mean the service tried to write an unbalanced or immutable ledger.
        const sqlstate = (err as ServiceError)?.details as { sqlstate?: string } | undefined;
        if (!(err instanceof ServiceError) || err.code === 'INTERNAL' || sqlstate?.sqlstate) {
          throw new Error(`step ${step} (${op}, seed ${SEED}) failed unexpectedly: ${(err as Error)?.stack ?? err}`);
        }
        if (process.env.LEDGER_PROPERTY_DEBUG) console.log(`step ${step} ${op} rejected: ${err.message}`);
        rejected[op] = (rejected[op] ?? 0) + 1;
      }
      await assertBooksBalance(`step ${step} (${op}, seed ${SEED})`);
    }

    if (process.env.LEDGER_PROPERTY_DEBUG) console.log(JSON.stringify({ succeeded, rejected }));
    // The run must actually have exercised the ledger, not just bounced off validation.
    for (const op of ['invoice', 'receivePayment', 'buyInventory', 'payBill', 'journalEntry', 'deposit', 'transfer']) {
      expect(succeeded[op] ?? 0, `${op} never succeeded (rejected ${rejected[op] ?? 0}x)`).toBeGreaterThan(0);
    }
    expect(succeeded.tamper ?? 0).toBeGreaterThan(0);
    const [{ n }] = (
      await db.execute(sql`SELECT count(*)::int AS n FROM journal_entries WHERE company_id = ${ctx.companyId}`)
    ).rows as Array<{ n: number }>;
    expect(n).toBeGreaterThan(STEPS / 3);
  }, 240_000);

  it('reports the books in balance with every guard active after the random run', async () => {
    const status = await booksInBalance(ctx);
    expect(status.guards.missing).toEqual([]);
    expect(status.trialBalance.ok).toBe(true);
    expect(status.balanceSheet.ok).toBe(true);
    expect(status.cashBasisBalanceSheet.ok).toBe(true);
    expect(status.accountBalances.ok).toBe(true);
    expect(status.inBalance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function invoiceCustomer(invoiceId: string): Promise<string | undefined> {
  const r = await db.execute(sql`SELECT customer_id FROM invoices WHERE id = ${invoiceId}`);
  return (r.rows[0] as { customer_id?: string } | undefined)?.customer_id;
}

async function openBalance(table: 'invoices' | 'bills', id: string): Promise<string> {
  const r = await db.execute(sql`SELECT balance_due FROM ${sql.identifier(table)} WHERE id = ${id}`);
  return toAmountString((r.rows[0] as { balance_due?: string } | undefined)?.balance_due ?? 0);
}

async function billVendor(billId: string): Promise<string | undefined> {
  const r = await db.execute(sql`SELECT vendor_id FROM bills WHERE id = ${billId}`);
  return (r.rows[0] as { vendor_id?: string } | undefined)?.vendor_id;
}

/**
 * Raw-SQL attacks on the ledger. Each MUST be refused by the database; the attempt counts as
 * a success only when it was refused (a tamper that went through fails the test right here).
 */
async function tamperAttempt(rand: () => number): Promise<void> {
  const [line] = await db
    .select({ id: journalEntryLines.id, entryId: journalEntryLines.journalEntryId })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')))
    .limit(1)
    .offset(Math.floor(rand() * 20));
  if (!line) return;
  const attempts: Array<() => Promise<unknown>> = [
    () => db.execute(sql`UPDATE journal_entry_lines SET debit = coalesce(debit, 0) + 1 WHERE id = ${line.id}`),
    () => db.execute(sql`DELETE FROM journal_entry_lines WHERE id = ${line.id}`),
    () => db.execute(sql`UPDATE accounts SET balance = balance + 0.01 WHERE id = ${acct['1000']}`),
    () => db.execute(sql`DELETE FROM journal_entries WHERE id = ${line.entryId}`),
    () =>
      db.transaction(async (tx) => {
        const [e] = await tx
          .insert(journalEntries)
          .values({ companyId: ctx.companyId, entryNumber: 999999, date: new Date(), description: 'forged', status: 'posted', createdBy: ctx.userId! })
          .returning();
        await tx.insert(journalEntryLines).values([
          { journalEntryId: e.id, accountId: acct['1000'], debit: '10.00' },
          { journalEntryId: e.id, accountId: acct['4000'], credit: '9.99' },
        ]);
      }),
  ];
  const attempt = attempts[Math.floor(rand() * attempts.length)];
  let refused = false;
  try {
    await attempt();
  } catch (err) {
    refused = /LEDGER/.test(String((err as Error).message));
    if (!refused) throw err;
  }
  expect(refused, 'the database accepted a raw-SQL ledger tamper').toBe(true);
}

/** The four invariants, checked independently from raw SQL AND through the report services. */
async function assertBooksBalance(where: string): Promise<void> {
  // (1) Raw ledger: every posted entry balances and the whole ledger nets to zero.
  const unbalanced = (
    await db.execute(sql`
      SELECT e.id FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = ${ctx.companyId} AND e.status = 'posted'
      GROUP BY e.id HAVING coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0) OR count(*) < 2`)
  ).rows;
  expect(unbalanced, `${where}: unbalanced posted entries`).toHaveLength(0);

  // (4) Raw: cached balance == ledger-derived natural balance for every account.
  const drift = (
    await db.execute(sql`
      SELECT a.code, a.balance,
        coalesce(sum(CASE WHEN a.type IN ('asset', 'expense')
                          THEN coalesce(l.debit, 0) - coalesce(l.credit, 0)
                          ELSE coalesce(l.credit, 0) - coalesce(l.debit, 0) END)
                 FILTER (WHERE e.status = 'posted'), 0) AS derived
      FROM accounts a
      LEFT JOIN journal_entry_lines l ON l.account_id = a.id
      LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE a.company_id = ${ctx.companyId}
      GROUP BY a.id, a.code, a.balance
      HAVING a.balance <> coalesce(sum(CASE WHEN a.type IN ('asset', 'expense')
                          THEN coalesce(l.debit, 0) - coalesce(l.credit, 0)
                          ELSE coalesce(l.credit, 0) - coalesce(l.debit, 0) END)
                 FILTER (WHERE e.status = 'posted'), 0)`)
  ).rows;
  expect(drift, `${where}: cached balances drifted from the ledger`).toHaveLength(0);

  // (1)(2)(3) Through the report services (these also assert internally and would throw).
  const tb = await trialBalance(ctx);
  expect(tb.totalDebit, `${where}: trial balance`).toBe(tb.totalCredit);
  const bs = await balanceSheet(ctx);
  expect(bs.totalAssets, `${where}: accrual balance sheet`).toBe(
    toAmountString(Money.add(bs.totalLiabilities, bs.totalEquity)),
  );
  expect(bs.retainedEarnings).toBe(toAmountString(Money.add(bs.priorYearsEarnings, bs.currentYearNetIncome)));
  const cash = await balanceSheetCashBasis(ctx);
  expect(cash.totals.totalAssets, `${where}: cash-basis balance sheet`).toBe(cash.totals.totalLiabilitiesAndEquity);
  // Cash-basis equity lines + cash retained earnings add up to the reported total equity.
  expect(toAmountString(Money.add(...cash.equity.map((l) => l.amount), cash.retainedEarnings))).toBe(
    cash.totals.totalEquity,
  );
}
