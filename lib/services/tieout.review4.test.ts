/**
 * Review round 4 — report TIE-OUTS on one rich company.
 *
 * Builds ~14 months of books (Aug 2025 – Sep 2026) for a company with a JUNE 30 fiscal year end, so
 * the data crosses a fiscal year end (FY2026 = Jul 2025 – Jun 2026) and a year-end close:
 * invoices / payments / credits, bills / bill payments / vendor credits, inventory purchases and
 * sales, payroll, deposits, transfers, a EUR customer and vendor with a Home Currency Adjustment,
 * classes, customer:jobs and the jobs list, budgets, edited and voided documents, one closed
 * period and one completed bank reconciliation.
 *
 * Then every pair of reports that must agree is compared for several as-of dates and ranges
 * (month / fiscal-year boundaries), on the accrual and the cash basis, and every report in the
 * catalog is run once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { isCashAccount } from '@/lib/accountTypes';
import type { StdReport, StdRow } from '@/lib/reports/types';
import { REPORT_CATALOG } from '@/lib/reports/catalog';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { setBaseCurrency, upsertCurrency, setAccountCurrency } from './currencies';
import { createClass, createLocation } from './dimensions';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createItem } from './items';
import { createJob } from './jobs';
import { createTaxAgency, createTaxRate } from './salesTax';
import { createEmployee, runPaycheck, voidPaycheck } from './payroll';
import { postJournalEntry } from './posting';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { receivePayment } from './payments';
import { createSalesReceipt } from './salesReceipts';
import { createDeposit } from './deposits';
import { createCreditMemo, applyToInvoice } from './creditMemos';
import { createBill, updateBill } from './bills';
import { payBills, voidBillPayment } from './billPayments';
import { createVendorCredit, applyToBill } from './vendorCredits';
import { createExpense, voidExpense } from './expenses';
import { createTransfer } from './transfers';
import { adjustInventory, inventoryValuation, inventoryValuationAsOf, inventoryValuationDetail } from './inventory';
import { createHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { paySalesTax, payPayrollLiabilities } from './liabilityPayments';
import { yearEndClose } from './fiscalClose';
import { closePeriod } from './fiscalPeriods';
import { createBankAccount } from './bankAccounts';
import { completeReconciliation, getReconciliationReport, listClearable, startReconciliation, toggleCleared } from './reconcile';
import { createBudget, setBudgetLine, budgetVsActual } from './budgets';
import { runStandardReport } from './reportRegistry';
import { balanceSheet, profitAndLoss, trialBalance } from './reports';
import { arAging, apAging, cashFlow, salesByItem } from './reportsExtra';
import { employeeEarningsSummary, form941Data, payrollDetail, payrollItemDetail, payrollLiabilityBalances, payrollSummary, payrollTransactionsByPayee, w2Data } from './payrollReports';
import { accountRegister, generalLedger } from './journal';
import { profitAndLossCashBasis } from './cashBasisReports';
import { balanceSheetCashBasis, cashBasisBalanceSheet } from './balanceSheetCashBasis';
import { runReport } from './reportBuilder';
import { runMemorizedReport, saveMemorizedReport } from './memorizedReports';
import { getDashboardInsights } from './dashboard';
import { consolidatedBalanceSheet, consolidatedPL } from './consolidation';
import { quantityOnHandBySite } from './inventorySiteReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-tieout');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const S: Record<string, string> = {}; // ids of things created (customers, vendors, items, …)

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const m2 = (v: unknown) => toAmountString(Money.of(v === null || v === undefined || v === '' ? 0 : (v as string)));
const add = (...v: unknown[]) => toAmountString(Money.add(...v.map((x) => Money.of(x === null || x === undefined || x === '' ? 0 : (x as string)))));
const sub = (a: unknown, b: unknown) => toAmountString(Money.of(m2(a)).minus(Money.of(m2(b))));
const neg = (a: unknown) => toAmountString(Money.of(m2(a)).negated());

const run = (key: string, params: Record<string, unknown> = {}) => runStandardReport(ctx, key, params);
const rowById = (r: StdReport, id: string): StdRow | undefined => r.rows.find((x) => x.id === id);
const cell = (r: StdReport, id: string, col = 'total'): string => {
  const x = rowById(r, id);
  return x ? m2(x.cells[col]) : '0.00';
};
const grandRow = (r: StdReport) => r.rows.filter((x) => x.kind === 'grand').at(-1)!;
const grand = (r: StdReport, col: string) => m2(grandRow(r)?.cells[col]);

/** Next calendar day (YYYY-MM-DD). */
const nextDay = (s: string) => new Date(d(s).getTime() + 86_400_000).toISOString().slice(0, 10);
const prevDay = (s: string) => new Date(d(s).getTime() - 86_400_000).toISOString().slice(0, 10);

/** FY (Jun 30 year end) start of the fiscal year containing `s`. */
const fyStart = (s: string) => {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  return mo >= 7 ? `${y}-07-01` : `${y - 1}-07-01`;
};

let acctMeta: { id: string; code: string; type: string; subtype: string; name: string }[] = [];

/** Natural balance of one account at the end of `asOf` (balanceSheet() lines; P&L accounts → 0 here). */
async function bsLine(code: string, asOf: string): Promise<string> {
  const bs = await balanceSheet(ctx, eod(asOf));
  const line = [...bs.assets, ...bs.liabilities, ...bs.equity].find((l) => l.accountId === A[code]);
  return m2(line?.amount);
}
/** Cash (bank + Undeposited Funds) at the end of `asOf`. */
async function cashAt(asOf: string): Promise<string> {
  const bs = await balanceSheet(ctx, eod(asOf));
  const cashIds = new Set(acctMeta.filter((a) => isCashAccount(a as never)).map((a) => a.id));
  return add(...bs.assets.filter((l) => cashIds.has(l.accountId)).map((l) => l.amount));
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`build step "${name}" failed: ${(err as Error).message}`, { cause: err });
  }
}

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

const MONTHS = [
  '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
  '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
];

async function buildCompany() {
  const [user] = await db.insert(users).values({ email: 'review4-tieout@test.local', name: 'R4 Tieout', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Tieout Co', ownerId: user.id, settings: { fiscalYearEnd: '06-30' } });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;

  await step('currencies', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    A['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(ctx, A['1020'], 'EUR');
    A['2400'] = (await createAccount(ctx, { code: '2400', name: 'Accrued Liabilities', type: 'liability' as never, subtype: 'other_current_liability' })).id;
  });

  await step('lists', async () => {
    S.east = (await createClass(ctx, { name: 'East' })).id;
    S.west = (await createClass(ctx, { name: 'West' })).id;
    S.locMain = (await createLocation(ctx, { name: 'Main Store' })).id;
    S.locWh = (await createLocation(ctx, { name: 'Warehouse' })).id;
    S.alpha = (await createCustomer(ctx, { displayName: 'Alpha Corp' } as never)).id;
    S.alphaKitchen = (await createCustomer(ctx, { displayName: 'Kitchen Remodel', parentId: S.alpha } as never)).id;
    S.beta = (await createCustomer(ctx, { displayName: 'Beta LLC' } as never)).id;
    S.gamma = (await createCustomer(ctx, { displayName: 'Gamma Stores' } as never)).id;
    S.euroCo = (await createCustomer(ctx, { displayName: 'EuroCo GmbH' } as never)).id;
    S.jobX = (await createJob(ctx, { customerId: S.alpha, name: 'Project X' } as never)).id;
    S.supply = (await createVendor(ctx, { displayName: 'SupplyCo' } as never)).id;
    S.landlord = (await createVendor(ctx, { displayName: 'Landlord Inc' } as never)).id;
    S.utility = (await createVendor(ctx, { displayName: 'City Utility' } as never)).id;
    S.euroVend = (await createVendor(ctx, { displayName: 'EuroVend SA' } as never)).id;
    await db.update(vendors).set({ currency: 'EUR' }).where(eq(vendors.id, S.euroVend));
    S.widget = (await createItem(ctx, { name: 'Widget', type: 'inventory', salesPrice: 100, purchaseCost: 40, incomeAccountId: A['4000'], expenseAccountId: A['5000'], assetAccountId: A['1300'] } as never)).id;
    S.gadget = (await createItem(ctx, { name: 'Gadget', type: 'inventory', salesPrice: 60, purchaseCost: 25, incomeAccountId: A['4000'], expenseAccountId: A['5000'], assetAccountId: A['1300'] } as never)).id;
    S.consult = (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: 150, incomeAccountId: A['4100'], taxable: false } as never)).id;
    const agency = await createTaxAgency(ctx, { name: 'State DOR', liabilityAccountId: A['2200'] });
    S.agency = agency.id;
    S.tax = (await createTaxRate(ctx, { name: 'State 8%', rate: '0.08', agencyId: agency.id })).id;
    S.emp1 = (await createEmployee(ctx, { firstName: 'Ann', lastName: 'Able', payType: 'salary', payRate: 52000 })).id;
    S.emp2 = (await createEmployee(ctx, { firstName: 'Bob', lastName: 'Baker', payType: 'hourly', payRate: 25 })).id;
  });

  // Opening: owner investment.
  await step('opening', () =>
    postJournalEntry(ctx, {
      date: d('2025-08-01'),
      description: 'Owner investment',
      lines: [
        { accountId: A['1000'], debit: '100000.00' },
        { accountId: A['3000'], credit: '100000.00' },
      ],
    }),
  );

  // Inventory purchase.
  await step('inventory bill 1', async () => {
    const b = await createBill(ctx, {
      vendorId: S.supply,
      billNumber: 'SUP-1',
      date: d('2025-08-02'),
      dueDate: d('2025-09-01'),
      classId: S.west,
      lines: [
        { itemId: S.widget, quantity: 100, unitCost: 40, classId: S.west },
        { itemId: S.gadget, quantity: 50, unitCost: 25, classId: S.west },
      ],
    });
    S.bill1 = b.id;
  });

  const openInv: Record<string, { id: string; total: string }[]> = { alpha: [], gamma: [] };
  const undeposited: { payments: string[]; receipts: string[] } = { payments: [], receipts: [] };
  const utilityBills: { id: string; total: string }[] = [];

  for (let i = 0; i < MONTHS.length; i++) {
    const ym = MONTHS[i];
    const day = (n: number) => d(`${ym}-${String(n).padStart(2, '0')}`);
    const due = (n: number) => new Date(day(n).getTime() + 30 * 86_400_000);

    if (ym === '2026-07') {
      // Year-end close of FY2026, then a late adjusting entry dated in the closed year, then lock it.
      await step('year-end close FY2026', () => yearEndClose(ctx, { fiscalYear: 2026 }));
      await step('late accrual after close', () =>
        postJournalEntry(ctx, {
          date: d('2026-06-30'),
          description: 'Late accrued insurance (after close)',
          isAdjusting: true,
          lines: [
            { accountId: A['6200'], debit: '500.00', classId: S.east },
            { accountId: A['2400'], credit: '500.00' },
          ],
        } as never),
      );
      await step('close period FY2026', () => closePeriod(ctx, { periodStart: d('2025-07-01'), periodEnd: eod('2026-06-30') }));
    }

    // Rent check (class East).
    await step(`${ym} rent`, () =>
      createExpense(ctx, {
        vendorId: S.landlord,
        date: day(3),
        method: 'check',
        paymentAccountId: A['1000'],
        lines: [{ accountId: A['6400'], amount: '2000.00', classId: S.east } as never],
      }),
    );

    // Consulting invoice to Alpha (class East); some on the jobs list job, one month on the sub-customer.
    await step(`${ym} alpha invoice`, async () => {
      const inv = await createInvoice(ctx, {
        customerId: ym === '2025-10' ? S.alphaKitchen : S.alpha,
        date: day(5),
        dueDate: due(5),
        classId: S.east,
        jobId: i % 3 === 0 ? S.jobX : null,
        lines: [{ itemId: S.consult, quantity: 10, rate: '150.00', taxable: false }],
      } as never);
      openInv.alpha.push({ id: inv.id, total: inv.total });
      if (ym === '2025-09') S.alphaSep = inv.id;
    });

    // Taxable Widget invoice to Gamma (class West).
    await step(`${ym} gamma invoice`, async () => {
      const inv = await createInvoice(ctx, {
        customerId: S.gamma,
        date: day(8),
        dueDate: due(8),
        classId: S.west,
        taxRateId: S.tax,
        lines: [{ itemId: S.widget, quantity: 5, rate: '100.00', taxable: true }],
      } as never);
      openInv.gamma.push({ id: inv.id, total: inv.total });
      if (ym === '2025-11') S.gammaNov = inv.id;
    });

    // Walk-in sales receipt (Beta) to Undeposited Funds.
    await step(`${ym} sales receipt`, async () => {
      const sr = await createSalesReceipt(ctx, {
        customerId: S.beta,
        date: day(12),
        taxRateId: S.tax,
        classId: S.west,
        lines: [{ itemId: S.widget, quantity: 2, rate: 100, taxable: true }],
      } as never);
      undeposited.receipts.push(sr.id);
    });

    // Payroll.
    await step(`${ym} payroll`, async () => {
      const p1 = await runPaycheck(ctx, { employeeId: S.emp1, payDate: day(15), grossPay: '4333.33', periodsPerYear: 12 });
      await runPaycheck(ctx, { employeeId: S.emp2, payDate: day(15), earnings: [{ kind: 'regular', hours: 160, rate: 25 }], periodsPerYear: 12 });
      if (ym === '2026-05') S.voidedPaycheck = p1.id;
    });

    // Utility bill.
    await step(`${ym} utility bill`, async () => {
      const b = await createBill(ctx, {
        vendorId: S.utility,
        billNumber: `UT-${ym}`,
        date: day(18),
        dueDate: new Date(day(18).getTime() + 20 * 86_400_000),
        lines: [{ accountId: A['6600'], amount: '300.00', classId: S.east }],
      });
      utilityBills.push({ id: b.id, total: b.total });
    });

    // Customer payments for last month's invoices (to Undeposited Funds).
    if (i >= 1) {
      await step(`${ym} alpha payment`, async () => {
        const inv = openInv.alpha.shift()!;
        const pmt = await receivePayment(ctx, {
          customerId: MONTHS[i - 1] === '2025-10' ? S.alphaKitchen : S.alpha,
          date: day(20),
          method: 'check',
          reference: `A-${ym}`,
          amount: inv.total,
          applications: [{ invoiceId: inv.id, amountApplied: inv.total }],
        });
        undeposited.payments.push(pmt.payment.id);
      });
      // Gamma pays last month's invoice in full, except one month it pays half.
      if (ym !== '2025-12') {
        await step(`${ym} gamma payment`, async () => {
          const inv = openInv.gamma.shift()!;
          const partial = ym === '2026-03';
          const amount = partial ? '270.00' : inv.total;
          const pmt = await receivePayment(ctx, {
            customerId: S.gamma,
            date: day(22),
            method: 'check',
            reference: `G-${ym}`,
            amount,
            applications: [{ invoiceId: inv.id, amountApplied: amount }],
          });
          undeposited.payments.push(pmt.payment.id);
        });
      }
    }

    // Deposit what is in Undeposited Funds (leave the last month's items undeposited at FY end and at the end).
    if (ym !== '2026-06' && ym !== '2026-09') {
      await step(`${ym} deposit`, async () => {
        if (undeposited.payments.length + undeposited.receipts.length === 0) return;
        await createDeposit(ctx, {
          depositAccountId: A['1000'],
          date: day(25),
          paymentIds: undeposited.payments.splice(0),
          salesReceiptIds: undeposited.receipts.splice(0),
        });
      });
    }

    // Pay last month's utility bill.
    if (i >= 1) {
      await step(`${ym} pay utility`, async () => {
        const b = utilityBills.shift()!;
        const pay = await payBills(ctx, {
          vendorId: S.utility,
          date: day(27),
          method: 'check',
          paymentAccountId: A['1000'],
          applications: [{ billId: b.id, amountApplied: b.total }],
        });
        if (ym === '2026-06') {
          // Voided bill payment, re-paid the same day.
          await voidBillPayment(ctx, pay.id);
          await payBills(ctx, {
            vendorId: S.utility,
            date: day(28),
            method: 'check',
            paymentAccountId: A['1000'],
            applications: [{ billId: b.id, amountApplied: b.total }],
          });
        }
      });
    }

    // Transfer to savings every other month.
    if (i % 2 === 0) {
      await step(`${ym} transfer`, () =>
        createTransfer(ctx, { date: day(28), fromAccountId: A['1000'], toAccountId: A['1010'], amount: '1000.00', memo: 'To savings' }),
      );
    }

    // ---- one-off events ----
    if (ym === '2025-08') {
      await step('pay inventory bill 1', () =>
        payBills(ctx, { vendorId: S.supply, date: d('2025-08-30'), method: 'check', paymentAccountId: A['1000'], applications: [{ billId: S.bill1, amountApplied: '5250.00' }] }),
      );
      await step('credit card ad', () =>
        createExpense(ctx, { vendorId: S.supply, date: d('2025-08-14'), method: 'credit_card', paymentAccountId: A['2100'], lines: [{ accountId: A['6000'], amount: '250.00', classId: S.west } as never] }),
      );
    }
    if (ym === '2025-09') {
      // Edited invoice: Alpha's September invoice goes from 10 to 12 hours before it is paid.
      await step('edit alpha sep invoice', async () => {
        const upd = await updateInvoice(ctx, S.alphaSep, {
          customerId: S.alpha,
          date: d('2025-09-05'),
          dueDate: d('2025-10-05'),
          classId: S.east,
          lines: [{ itemId: S.consult, quantity: 12, rate: '150.00', taxable: false }],
        } as never);
        const o = openInv.alpha.find((x) => x.id === S.alphaSep)!;
        o.total = upd.total;
      });
    }
    if (ym === '2025-10') {
      await step('gadget invoice + voided invoice', async () => {
        await createInvoice(ctx, {
          customerId: S.beta,
          date: d('2025-10-14'),
          dueDate: d('2025-11-13'),
          classId: S.east,
          lines: [{ itemId: S.gadget, quantity: 10, rate: '60.00', taxable: false }],
        } as never);
        const bad = await createInvoice(ctx, {
          customerId: S.beta,
          date: d('2025-10-16'),
          dueDate: d('2025-11-15'),
          lines: [{ itemId: S.gadget, quantity: 3, rate: '60.00', taxable: false }],
        } as never);
        await voidInvoice(ctx, bad.id);
      });
    }
    if (ym === '2025-11') {
      await step('credit memo applied', async () => {
        const cm = await createCreditMemo(ctx, {
          customerId: S.gamma,
          date: d('2025-11-20'),
          taxRateId: S.tax,
          lines: [{ itemId: S.widget, quantity: 1, rate: '100.00', taxable: true }],
        } as never);
        await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: S.gammaNov, amount: cm.total, date: d('2025-11-21') });
        const o = openInv.gamma.find((x) => x.id === S.gammaNov)!;
        o.total = sub(o.total, cm.total);
      });
    }
    if (ym === '2025-12') {
      await step('eur invoice 1', async () => {
        const inv = await createInvoice(ctx, {
          customerId: S.euroCo,
          date: d('2025-12-05'),
          dueDate: d('2026-01-04'),
          currency: 'EUR',
          exchangeRate: '1.10',
          classId: S.east,
          lines: [{ itemId: S.consult, quantity: 1, rate: '5000.00', taxable: false }],
        } as never);
        S.eurInv1 = inv.id;
      });
    }
    if (ym === '2026-01') {
      await step('eur bill', async () => {
        const b = await createBill(ctx, {
          vendorId: S.euroVend,
          billNumber: 'EV-1',
          date: d('2026-01-10'),
          dueDate: d('2026-02-09'),
          currency: 'EUR',
          exchangeRate: '1.11',
          lines: [{ accountId: A['6000'], amount: '1000.00', classId: S.west }],
        });
        S.eurBill = b.id;
      });
      await step('eur payment', () =>
        receivePayment(ctx, {
          customerId: S.euroCo,
          date: d('2026-01-20'),
          method: 'ach',
          amount: '2000.00',
          depositAccountId: A['1020'],
          currency: 'EUR',
          exchangeRate: '1.12',
          applications: [{ invoiceId: S.eurInv1, amountApplied: '2000.00' }],
        } as never),
      );
      await step('sales tax payment Q2', async () => {
        const owed = await bsLine('2200', '2025-12-31');
        await paySalesTax(ctx, { amount: owed, date: d('2026-01-31'), paymentAccountId: A['1000'], agencyId: S.agency });
      });
    }
    if (ym === '2026-02') {
      await step('pay eur bill', () =>
        payBills(ctx, { vendorId: S.euroVend, date: d('2026-02-10'), method: 'ach', paymentAccountId: A['1020'], exchangeRate: '1.13', applications: [{ billId: S.eurBill, amountApplied: '1000.00' }] }),
      );
      await step('inventory bill 2', async () => {
        const b = await createBill(ctx, {
          vendorId: S.supply,
          billNumber: 'SUP-2',
          date: d('2026-02-15'),
          dueDate: d('2026-03-17'),
          lines: [{ itemId: S.widget, quantity: 50, unitCost: 44, classId: S.west }],
        });
        S.bill2 = b.id;
      });
      await step('voided rent check', async () => {
        const e = await createExpense(ctx, {
          vendorId: S.landlord,
          date: d('2026-02-04'),
          method: 'check',
          paymentAccountId: A['1000'],
          lines: [{ accountId: A['6400'], amount: '2000.00', classId: S.east } as never],
        });
        await voidExpense(ctx, e.id);
      });
    }
    if (ym === '2026-03') {
      await step('vendor credit applied + pay bill 2', async () => {
        const vc = await createVendorCredit(ctx, { vendorId: S.supply, date: d('2026-03-05'), lines: [{ accountId: A['6300'], amount: '150.00' }] } as never);
        await applyToBill(ctx, { vendorCreditId: vc.id, billId: S.bill2, amount: '150.00', date: d('2026-03-06') });
        await payBills(ctx, { vendorId: S.supply, date: d('2026-03-15'), method: 'check', paymentAccountId: A['1000'], applications: [{ billId: S.bill2, amountApplied: '2050.00' }] });
      });
      await step('home currency adjustment', () => createHomeCurrencyAdjustment(ctx, { date: d('2026-03-31'), rates: { EUR: '1.15' } }));
      await step('payroll liabilities Q3', async () => {
        const owed = await bsLine('2300', '2026-03-31');
        await payPayrollLiabilities(ctx, { amount: owed, date: d('2026-03-31'), paymentAccountId: A['1000'] });
      });
      await step('reconcile checking at 2026-03-31', async () => {
        const ba = await createBankAccount(ctx, { accountId: A['1000'], bankName: 'First Bank', accountNumber: '000123456789' });
        S.bankAcct = ba.id;
        const lines = await listClearable(ctx, ba.id, d('2026-03-31'));
        // Everything through March clears except the March rent check and the 03-31 liability payment.
        let cleared = Money.zero();
        const toClear = lines.filter((l) => !(l.date.toISOString().slice(0, 10) >= '2026-03-01' && l.credit && (Money.of(l.credit).eq(2000) || l.date.toISOString().slice(0, 10) === '2026-03-31')));
        for (const l of toClear) cleared = cleared.plus(Money.of(l.debit ?? 0)).minus(Money.of(l.credit ?? 0));
        const rec = await startReconciliation(ctx, { bankAccountId: ba.id, statementDate: d('2026-03-31'), statementBalance: toAmountString(cleared) });
        for (const l of toClear) await toggleCleared(ctx, rec.id, l.journalEntryLineId, true);
        await completeReconciliation(ctx, rec.id);
        S.recon = rec.id;
        S.reconBalance = toAmountString(cleared);
      });
    }
    if (ym === '2026-04') {
      await step('inventory shrinkage', () => adjustInventory(ctx, { itemId: S.widget, quantityChange: -2, date: d('2026-04-30'), memo: 'Shrinkage' }));
      await step('edit utility bill', async () => {
        const b = utilityBills[utilityBills.length - 1];
        const upd = await updateBill(ctx, b.id, {
          vendorId: S.utility,
          billNumber: 'UT-2026-04',
          date: d('2026-04-18'),
          dueDate: d('2026-05-08'),
          lines: [{ accountId: A['6600'], amount: '350.00', classId: S.east }],
        });
        b.total = upd.total;
      });
    }
    if (ym === '2026-05') {
      await step('eur invoice 2', () =>
        createInvoice(ctx, {
          customerId: S.euroCo,
          date: d('2026-05-01'),
          dueDate: d('2026-05-31'),
          currency: 'EUR',
          exchangeRate: '1.16',
          lines: [{ itemId: S.consult, quantity: 1, rate: '1500.00', taxable: false }],
        } as never),
      );
      await step('voided + re-run paycheck', async () => {
        await voidPaycheck(ctx, S.voidedPaycheck);
        await runPaycheck(ctx, { employeeId: S.emp1, payDate: d('2026-05-16'), grossPay: '4333.33', periodsPerYear: 12 });
      });
    }
    if (ym === '2026-07') {
      await step('sales tax payment FY end', async () => {
        const owed = await bsLine('2200', '2026-06-30');
        await paySalesTax(ctx, { amount: owed, date: d('2026-07-31'), paymentAccountId: A['1000'], agencyId: S.agency });
      });
    }
    if (ym === '2026-08') {
      await step('invoice with a header discount', () =>
        createInvoice(ctx, {
          customerId: S.alpha,
          date: d('2026-08-10'),
          dueDate: d('2026-09-09'),
          classId: S.east,
          discount: 10,
          discountType: 'percent',
          lines: [{ itemId: S.consult, quantity: 10, rate: '150.00', taxable: false }],
        } as never),
      );
      await step('overpayment (unapplied credit) from Beta', () =>
        receivePayment(ctx, { customerId: S.beta, date: d('2026-08-12'), method: 'check', reference: 'B-OVER', amount: '75.00', applications: [] }),
      );
      await step('general journal A/R charge to Gamma', () =>
        postJournalEntry(ctx, {
          date: d('2026-08-15'),
          description: 'Late fee charged by journal',
          lines: [
            { accountId: A['1200'], debit: '25.00', entityType: 'customer', entityId: S.gamma },
            { accountId: A['4900'], credit: '25.00' },
          ],
        } as never),
      );
    }
    if (ym === '2026-09') {
      await step('item with its own COGS account', async () => {
        A['5100'] = (await createAccount(ctx, { code: '5100', name: 'COGS - Gizmos', type: 'expense' as never, subtype: 'cost_of_goods_sold' })).id;
        S.gizmo = (await createItem(ctx, { name: 'Gizmo', type: 'inventory', salesPrice: 30, purchaseCost: 10, incomeAccountId: A['4000'], expenseAccountId: A['5100'], assetAccountId: A['1300'] } as never)).id;
        await createBill(ctx, { vendorId: S.supply, billNumber: 'SUP-3', date: d('2026-09-02'), dueDate: d('2026-10-02'), lines: [{ itemId: S.gizmo, quantity: 10, unitCost: 10 }] });
        await createInvoice(ctx, {
          customerId: S.beta,
          date: d('2026-09-20'),
          dueDate: d('2026-10-20'),
          classId: S.west,
          lines: [{ itemId: S.gizmo, quantity: 2, rate: '30.00', taxable: false }],
        } as never);
      });
      await step('payroll liabilities partial', async () => {
        await payPayrollLiabilities(ctx, { amount: '1000.00', date: d('2026-09-10'), paymentAccountId: A['1000'] });
      });
    }
  }

  await step('budgets', async () => {
    const b = await createBudget(ctx, { name: 'FY2026 Plan', fiscalYear: 2026 });
    S.budget = b.id;
    for (let mo = 1; mo <= 12; mo++) {
      await setBudgetLine(ctx, { budgetId: b.id, accountId: A['4100'], month: mo, amount: '1500.00' });
      await setBudgetLine(ctx, { budgetId: b.id, accountId: A['6400'], month: mo, amount: '2000.00' });
    }
  });

  acctMeta = (await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).map((a) => ({
    id: a.id,
    code: a.code,
    type: String(a.type),
    subtype: String(a.subtype),
    name: a.name,
  }));
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  await buildCompany();
}, 900_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const AS_OF = ['2025-08-31', '2025-12-31', '2026-01-01', '2026-03-31', '2026-04-01', '2026-06-30', '2026-07-01', '2026-09-30'];
const RANGES: [string, string][] = [
  ['2025-07-01', '2026-06-30'], // FY2026
  ['2026-07-01', '2026-09-30'], // FY2027 to date
  ['2025-12-01', '2025-12-31'], // calendar year-end month
  ['2026-06-01', '2026-06-30'], // fiscal year-end month
  ['2026-07-01', '2026-07-31'], // first month after the close
  ['2026-05-01', '2026-08-31'], // across the fiscal year end
  ['2025-08-01', '2026-09-30'], // all activity
];

describe('build sanity', () => {
  it('the company was built', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. Trial balance / balance sheet / P&L
// ---------------------------------------------------------------------------

describe('trial balance and balance sheet', () => {
  it('TB total debits = credits and BS assets = liabilities + equity, every as-of date, both bases', async () => {
    for (const asOf of [...AS_OF, '2026-10-17']) {
      for (const basis of ['accrual', 'cash']) {
        const tb = await run('trial-balance', { asOf, basis });
        expect.soft(grand(tb, 'debit'), `TB ${basis} ${asOf}`).toBe(grand(tb, 'credit'));
        expect.soft(tb.balanced, `TB balanced flag ${basis} ${asOf}`).toBe(true);
        const bs = await run('balance-sheet', { asOf, basis });
        expect.soft(cell(bs, 'bs:assets:total'), `BS ${basis} ${asOf}`).toBe(cell(bs, 'bs:le:total'));
        if (basis === 'accrual') {
          // Review 5: the report shows the trial balance as QuickBooks does — balance-sheet
          // accounts at the ledger balance, income / expense accounts for the fiscal year to date,
          // and earlier years' income in Retained Earnings (3900 = the balance sheet's line).
          const raw = await trialBalance(ctx, eod(asOf));
          const isPL = (id: string) => ['revenue', 'expense'].includes(acctMeta.find((a) => a.id === id)?.type ?? '');
          for (const r of raw.rows) {
            if (isPL(r.accountId) || r.accountId === A['3900']) continue;
            const t = rowById(tb, `tb:a:${r.accountId}`);
            expect.soft(sub(t?.cells.debit, t?.cells.credit), `TB report vs trialBalance() ${r.code} ${asOf}`).toBe(sub(r.debit, r.credit));
          }
          let plNet = Money.zero();
          for (const t of tb.rows) {
            const id = /^tb:a:(.+)$/.exec(t.id)?.[1];
            if (id && isPL(id) && t.kind === 'data') plNet = plNet.plus(Money.of(sub(t.cells.credit, t.cells.debit)));
          }
          const pl = await run('profit-loss', { from: fyStart(asOf), to: asOf });
          expect.soft(toAmountString(plNet), `TB P&L accounts = P&L fiscal YTD ${asOf}`).toBe(cell(pl, 'pl:net'));
          const reRow = rowById(tb, `tb:a:${A['3900']}`);
          expect.soft(sub(reRow?.cells.credit, reRow?.cells.debit), `TB Retained Earnings = BS ${asOf}`).toBe(cell(bs, `bs:equity:a:${A['3900']}`));
        }
      }
    }
  });

  // Review 4 finding: as of the fiscal year END date, after the year-end close, the balance sheet's
  // Net Income line shows only what was posted after the close (the closing entry, dated on that day,
  // was counted in the current-year split — reports.ts balanceSheet()).
  it('BS Net Income = P&L net income for the fiscal year to date (fiscal-year aware), both bases', async () => {
    for (const asOf of AS_OF) {
      for (const basis of ['accrual', 'cash']) {
        const bs = await run('balance-sheet', { asOf, basis });
        const pl = await run('profit-loss', { from: fyStart(asOf), to: asOf, basis });
        expect.soft(cell(bs, 'bs:ni'), `BS NI vs P&L YTD ${basis} ${asOf}`).toBe(cell(pl, 'pl:net'));
      }
    }
  });

  it('Retained Earnings after the year-end close = all earnings before the current fiscal year', async () => {
    for (const asOf of ['2026-07-01', '2026-09-30']) {
      const bs = await run('balance-sheet', { asOf });
      const re = cell(bs, `bs:equity:a:${A['3900']}`);
      const prior = await run('profit-loss', { from: '1900-01-01', to: prevDay(fyStart(asOf)) });
      expect.soft(re, `RE ${asOf}`).toBe(cell(prior, 'pl:net'));
      const raw = await balanceSheet(ctx, eod(asOf));
      expect.soft(add(await bsLine('3900', asOf), raw.priorYearsEarnings), `RE parts ${asOf}`).toBe(re);
      // Cash basis: RE = cash-basis earnings before the fiscal year.
      const cbs = await run('balance-sheet', { asOf, basis: 'cash' });
      const cprior = await run('profit-loss', { from: '1900-01-01', to: prevDay(fyStart(asOf)), basis: 'cash' });
      expect.soft(cell(cbs, `bs:equity:a:${A['3900']}`), `cash RE ${asOf}`).toBe(cell(cprior, 'pl:net'));
    }
  });

  it('the closing entry moved exactly FY2026 net income (before the late adjustment) into 3900', async () => {
    const fy = await run('profit-loss', { from: '2025-07-01', to: '2026-06-30' });
    // The late accrual (500, after the close) is not in 3900.
    expect.soft(await bsLine('3900', '2026-07-01')).toBe(add(cell(fy, 'pl:net'), '500.00'));
  });

  it('BS summary, by-period and prev-year columns agree with the standard BS', async () => {
    for (const asOf of ['2026-03-31', '2026-06-30', '2026-09-30']) {
      const bs = await run('balance-sheet', { asOf });
      const sum = await run('balance-sheet-summary', { asOf });
      expect.soft(cell(sum, 'bs:assets:total'), `summary ${asOf}`).toBe(cell(bs, 'bs:assets:total'));
      expect.soft(cell(sum, 'bs:ni'), `summary NI ${asOf}`).toBe(cell(bs, 'bs:ni'));
    }
    const byp = await run('balance-sheet-by-period', { from: '2026-04-01', to: '2026-09-30', columns: 'month' });
    const months = byp.columns.filter((c) => /^p\d+$/.test(c.key));
    expect.soft(months.length).toBe(6);
    for (const c of months) {
      const h = c.header; // MM/DD/YYYY
      const iso = `${h.slice(6, 10)}-${h.slice(0, 2)}-${h.slice(3, 5)}`;
      const bs = await run('balance-sheet', { asOf: iso });
      expect.soft(cell(byp, 'bs:assets:total', c.key), `by period ${iso}`).toBe(cell(bs, 'bs:assets:total'));
      expect.soft(cell(byp, 'bs:ni', c.key), `by period NI ${iso}`).toBe(cell(bs, 'bs:ni'));
    }
    const py = await run('balance-sheet-prev-year', { asOf: '2026-09-30' });
    const bsPrior = await run('balance-sheet', { asOf: '2025-09-30' });
    expect.soft(cell(py, 'bs:assets:total', 'prev')).toBe(cell(bsPrior, 'bs:assets:total'));
    expect.soft(cell(py, 'bs:ni', 'prev')).toBe(cell(bsPrior, 'bs:ni'));
  });
});

describe('profit & loss variants', () => {
  it('standard = detail = by month / quarter / year = by class = by job = YTD / comparison columns', async () => {
    for (const [from, to] of RANGES) {
      for (const basis of ['accrual', 'cash']) {
        const tag = `${basis} ${from}..${to}`;
        const std = await run('profit-loss', { from, to, basis });
        const net = cell(std, 'pl:net');
        const detail = await run('profit-loss-detail', { from, to, basis });
        expect.soft(cell(detail, 'pld:net', 'amount'), `detail ${tag}`).toBe(net);
        for (const columns of ['month', 'quarter', 'year']) {
          const byp = await run('profit-loss', { from, to, basis, columns });
          expect.soft(cell(byp, 'pl:net'), `by ${columns} total ${tag}`).toBe(net);
          const pcols = byp.columns.filter((c) => /^p\d+$/.test(c.key)).map((c) => cell(byp, 'pl:net', c.key));
          expect.soft(add(...pcols), `sum of ${columns} columns ${tag}`).toBe(net);
        }
        const byMonth = await run('profit-loss-by-month', { from, to, basis });
        expect.soft(cell(byMonth, 'pl:net'), `P&L by Month ${tag}`).toBe(net);
        const byClass = await run('pl-by-class', { from, to, basis });
        expect.soft(cell(byClass, 'pl:net'), `by class total ${tag}`).toBe(net);
        const ccols = byClass.columns.filter((c) => /^c\d+$/.test(c.key)).map((c) => cell(byClass, 'pl:net', c.key));
        expect.soft(add(...ccols), `sum of class columns ${tag}`).toBe(net);
        const east = await run('profit-loss', { from, to, basis, classId: S.east });
        const west = await run('profit-loss', { from, to, basis, classId: S.west });
        const eastCol = byClass.columns.find((c) => c.header === 'East');
        const westCol = byClass.columns.find((c) => c.header === 'West');
        if (eastCol) expect.soft(cell(east, 'pl:net'), `class filter East ${tag}`).toBe(cell(byClass, 'pl:net', eastCol.key));
        if (westCol) expect.soft(cell(west, 'pl:net'), `class filter West ${tag}`).toBe(cell(byClass, 'pl:net', westCol.key));
        const byJob = await run('profit-loss-by-job', { from, to, basis });
        expect.soft(cell(byJob, 'pl:net'), `by job total ${tag}`).toBe(net);
        const jcols = byJob.columns.filter((c) => /^c\d+$/.test(c.key)).map((c) => cell(byJob, 'pl:net', c.key));
        expect.soft(add(...jcols), `sum of job columns ${tag}`).toBe(net);
        const pct = await run('profit-loss-percent', { from, to, basis });
        expect.soft(cell(pct, 'pl:net'), `% of income ${tag}`).toBe(net);
        const ytd = await run('profit-loss-ytd', { from, to, basis });
        expect.soft(cell(ytd, 'pl:net', 'cur'), `YTD cur ${tag}`).toBe(net);
        const fyYtd = await run('profit-loss', { from: fyStart(to), to, basis });
        expect.soft(cell(ytd, 'pl:net', 'ytd'), `YTD ytd ${tag}`).toBe(cell(fyYtd, 'pl:net'));
        const cmp = await run('profit-loss', { from, to, basis, compare: 'prev_period' });
        expect.soft(cell(cmp, 'pl:net', 'cur'), `compare cur ${tag}`).toBe(net);
        const py = await run('profit-loss-prev-year', { from, to, basis });
        expect.soft(cell(py, 'pl:net', 'cur'), `prev year cur ${tag}`).toBe(net);
        const shift = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;
        const prior = await run('profit-loss', { from: shift(from), to: shift(to), basis });
        expect.soft(cell(py, 'pl:net', 'prev'), `prev year prev ${tag}`).toBe(cell(prior, 'pl:net'));
        if (basis === 'accrual') {
          const raw = await profitAndLoss(ctx, { from: d(from), to: eod(to) });
          expect.soft(raw.netIncome, `profitAndLoss() ${tag}`).toBe(net);
        } else {
          const raw = await profitAndLossCashBasis(ctx, { from: d(from), to: eod(to) });
          expect.soft(raw.netIncome, `profitAndLossCashBasis() ${tag}`).toBe(net);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Cash flow
// ---------------------------------------------------------------------------

describe('statement of cash flows', () => {
  it('ending cash = BS cash at "to", beginning = BS cash the day before "from", net change = the difference', async () => {
    for (const [from, to] of RANGES) {
      const scf = await run('statement-of-cash-flows', { from, to });
      const begin = await cashAt(prevDay(from));
      const end = await cashAt(to);
      expect.soft(cell(scf, 'scf:begin'), `begin ${from}..${to}`).toBe(begin);
      expect.soft(cell(scf, 'scf:end'), `end ${from}..${to}`).toBe(end);
      expect.soft(cell(scf, 'scf:net'), `net ${from}..${to}`).toBe(sub(end, begin));
      expect.soft(scf.balanced, `ties ${from}..${to}`).toBe(true);
      const pl = await run('profit-loss', { from, to });
      expect.soft(cell(scf, 'scf:ni'), `SCF NI ${from}..${to}`).toBe(cell(pl, 'pl:net'));
      expect.soft(add(cell(scf, 'scf:optotal'), cell(scf, 'scf:invtotal'), cell(scf, 'scf:fintotal')), `sections ${from}..${to}`).toBe(cell(scf, 'scf:net'));
      const opLines = scf.rows.filter((r) => r.parentId === 'scf:op' && r.kind === 'data').map((r) => r.cells.total);
      expect.soft(add(...opLines), `operating lines ${from}..${to}`).toBe(cell(scf, 'scf:optotal'));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. A/R and A/P
// ---------------------------------------------------------------------------

describe('A/R and A/P subledgers', () => {
  it('A/R: aging summary = detail = A/R control = customer balance summary = open invoices = legacy aging', async () => {
    for (const asOf of [...AS_OF, '2026-10-17']) {
      const ar = await bsLine('1200', asOf);
      const sum = await run('ar-aging-summary', { asOf });
      const det = await run('ar-aging-detail', { asOf });
      const cbs = await run('customer-balance-summary', { asOf });
      const open = await run('open-invoices', { asOf });
      const legacy = await arAging(ctx, eod(asOf));
      expect.soft(grand(sum, 'total'), `aging summary ${asOf}`).toBe(ar);
      expect.soft(JSON.stringify(grandRow(det).cells), `aging detail ${asOf} (A/R ${ar})`).toContain(`"${ar}"`);
      expect.soft(grand(cbs, 'balance'), `customer balance summary ${asOf}`).toBe(ar);
      expect.soft(JSON.stringify(grandRow(open).cells), `open invoices ${asOf} (A/R ${ar})`).toContain(`"${ar}"`);
      expect.soft(legacy.totals.total, `arAging() ${asOf}`).toBe(ar);
      const comb = await run('combined-ar-aging', { asOf });
      expect.soft(grand(comb, 'total'), `combined A/R aging ${asOf}`).toBe(ar);
    }
  });

  it('A/P: aging summary = detail = A/P control = vendor balance summary = unpaid bills = legacy aging', async () => {
    for (const asOf of [...AS_OF, '2026-10-17']) {
      const ap = await bsLine('2000', asOf);
      const sum = await run('ap-aging-summary', { asOf });
      const det = await run('ap-aging-detail', { asOf });
      const vbs = await run('vendor-balance-summary', { asOf });
      const unpaid = await run('unpaid-bills-detail', { asOf });
      const legacy = await apAging(ctx, eod(asOf));
      expect.soft(grand(sum, 'total'), `aging summary ${asOf}`).toBe(ap);
      expect.soft(JSON.stringify(grandRow(det).cells), `aging detail ${asOf} (A/P ${ap})`).toContain(`"${ap}"`);
      expect.soft(grand(vbs, 'balance'), `vendor balance summary ${asOf}`).toBe(ap);
      expect.soft(JSON.stringify(grandRow(unpaid).cells), `unpaid bills ${asOf} (A/P ${ap})`).toContain(`"${ap}"`);
      expect.soft(legacy.totals.total, `apAging() ${asOf}`).toBe(ap);
      const comb = await run('combined-ap-aging', { asOf });
      expect.soft(grand(comb, 'total'), `combined A/P aging ${asOf}`).toBe(ap);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Sales, inventory, payroll, sales tax
// ---------------------------------------------------------------------------

/** Income from the sales accounts (4000 Sales, 4100 Service) on a P&L report. */
const salesIncome = (pl: StdReport, col = 'total') => add(cell(pl, `pl:income:a:${A['4000']}`, col), cell(pl, `pl:income:a:${A['4100']}`, col));

describe('sales reports vs income accounts', () => {
  // Review 4 findings: foreign-currency documents were summed in their own currency, the invoice
  // header discount was left out, and Sales by Item COGS used the CURRENT average cost.
  it('sales by customer / item (summary + detail) = the sales income accounts, both bases', async () => {
    for (const [from, to] of RANGES) {
      for (const basis of ['accrual', 'cash']) {
        const tag = `${basis} ${from}..${to}`;
        const pl = await run('profit-loss', { from, to, basis });
        const sales = salesIncome(pl);
        for (const key of ['sales-by-customer-summary', 'sales-by-customer-detail', 'sales-by-item-summary', 'sales-by-item-detail']) {
          const r = await run(key, { from, to, basis });
          expect.soft(grand(r, 'amount'), `${key} ${tag}`).toBe(sales);
        }
        if (basis === 'accrual') {
          const jp = await run('job-profitability-summary', { from, to });
          expect.soft(grand(jp, 'revenue'), `job profitability revenue ${tag}`).toBe(sales);
          const legacy = await salesByItem(ctx, { from: d(from), to: eod(to) });
          expect.soft(legacy.totals.revenue, `salesByItem() ${tag}`).toBe(sales);
          // COGS of the items sold (5000 + the item COGS account; not the shrinkage adjustment account).
          const cogs = add(cell(pl, `pl:cogs:a:${A['5000']}`), A['5100'] ? cell(pl, `pl:cogs:a:${A['5100']}`) : '0');
          expect.soft(legacy.totals.cogs, `salesByItem() COGS vs P&L COGS ${tag}`).toBe(cogs);
          const sis = await run('sales-by-item-summary', { from, to });
          expect.soft(grand(sis, 'cogs'), `sales by item summary COGS vs P&L COGS ${tag}`).toBe(cogs);
        }
      }
    }
  });
});

describe('classes on sales and COGS', () => {
  // Review 4 findings: a sales receipt's class never reached its GL lines, and COGS lines carried no
  // class; COGS always went to account 5000 whatever the item's COGS account.
  it('class-filtered sales reports = class-filtered P&L sales income', async () => {
    for (const [from, to] of [['2025-07-01', '2026-06-30'], ['2026-07-01', '2026-09-30']] as [string, string][]) {
      for (const cls of ['east', 'west']) {
        const pl = await run('profit-loss', { from, to, classId: S[cls] });
        const sbc = await run('sales-by-customer-summary', { from, to, classId: S[cls] });
        expect.soft(grand(sbc, 'amount'), `sales by customer (${cls}) vs P&L (${cls}) ${from}..${to}`).toBe(salesIncome(pl));
      }
    }
  });

  it('COGS of a classed sale carries the class (P&L by Class gross profit)', async () => {
    // FY2026: the only East inventory sale is Beta's 10 Gadgets at $25 average cost.
    const east = await run('profit-loss', { from: '2025-07-01', to: '2026-06-30', classId: S.east });
    expect.soft(cell(east, 'pl:cogs:total'), 'East COGS').toBe('250.00');
    const west = await run('profit-loss', { from: '2025-07-01', to: '2026-06-30', classId: S.west });
    expect.soft(cell(west, 'pl:cogs:total'), 'West COGS is not zero').not.toBe('0.00');
  });

  it("COGS posts to the item's own COGS account", async () => {
    const pl = await run('profit-loss', { from: '2026-09-01', to: '2026-09-30' });
    expect.soft(cell(pl, `pl:cogs:a:${A['5100']}`), 'Gizmo COGS in 5100').toBe('20.00');
  });
});

describe('inventory valuation vs the inventory asset account', () => {
  it('quantity on hand by site = item quantity on hand; site value = valuation', async () => {
    const qoh = (await quantityOnHandBySite(ctx)) as { rows: { itemId: string; totalQuantity: string; totalValue: string }[] };
    const val = await inventoryValuation(ctx);
    for (const it of val.items) {
      const r = qoh.rows.find((x) => x.itemId === it.id);
      expect.soft(r?.totalQuantity ?? '0.0000', `site qty ${it.name}`).toBe(it.quantityOnHand);
      expect.soft(r?.totalValue ?? '0.00', `site value ${it.name}`).toBe(it.totalValue);
    }
  });

  it('valuation summary (current and as-of) = valuation detail = GL 1300', async () => {
    const now = await bsLine('1300', '2026-10-17');
    expect.soft((await inventoryValuation(ctx)).grandTotal, 'current valuation').toBe(now);
    for (const asOf of [...AS_OF, '2026-10-17']) {
      const gl = await bsLine('1300', asOf);
      expect.soft((await inventoryValuationAsOf(ctx, eod(asOf))).grandTotal, `as-of valuation ${asOf}`).toBe(gl);
      const det = await inventoryValuationDetail(ctx, { to: eod(asOf) });
      expect.soft(add(...det.items.map((x) => x.closingValue)), `valuation detail ${asOf}`).toBe(gl);
    }
    for (const [from, to] of RANGES) {
      const det = await inventoryValuationDetail(ctx, { from: d(from), to: eod(to) });
      expect.soft(add(...det.items.map((x) => x.openingValue)), `detail opening ${from}`).toBe(await bsLine('1300', prevDay(from)));
      expect.soft(add(...det.items.map((x) => x.closingValue)), `detail closing ${to}`).toBe(await bsLine('1300', to));
    }
  });
});

describe('payroll reports vs the payroll accounts', () => {
  it('payroll summary = paycheck postings; liability balances = GL 2300', async () => {
    for (const [from, to] of RANGES) {
      const tag = `${from}..${to}`;
      const ps = await payrollSummary(ctx, { from: d(from), to: eod(to) });
      const j = await run('journal', { from, to, txnType: 'paycheck' });
      // Every paycheck entry: debits = gross + employer taxes.
      expect.soft(grand(j, 'debit'), `paycheck debits ${tag}`).toBe(add(ps.totals.gross, ps.totals.totalEmployerTaxes));
      const bank = await run('transaction-detail-by-account', { from, to, accountId: A['1000'], txnType: 'paycheck' });
      expect.soft(neg(grand(bank, 'amount')), `net pay out of checking ${tag}`).toBe(ps.totals.net);
      const liab = await run('transaction-detail-by-account', { from, to, accountId: A['2300'], txnType: 'paycheck' });
      expect.soft(grand(liab, 'amount'), `2300 accrued by paychecks ${tag}`).toBe(add(ps.totals.totalTaxes, ps.totals.totalDeductions, ps.totals.totalEmployerTaxes));
      const exp = await run('profit-loss-detail', { from, to, txnType: 'paycheck' });
      expect.soft(neg(cell(exp, 'pld:net', 'amount')), `payroll expense ${tag}`).toBe(add(ps.totals.gross, ps.totals.totalEmployerTaxes));
      expect.soft(ps.totals.gross, `gross = taxes + deductions + net ${tag}`).toBe(add(ps.totals.totalTaxes, ps.totals.totalDeductions, ps.totals.net));
    }
    for (const asOf of [...AS_OF, '2026-10-17']) {
      const lb = await payrollLiabilityBalances(ctx, { asOf: d(asOf) });
      expect.soft(lb.balance, `payroll liability balance ${asOf}`).toBe(await bsLine('2300', asOf));
    }
  });
});

describe('sales tax liability vs Sales Tax Payable', () => {
  it('Sales Tax Liability report opening / ending = GL 2200', async () => {
    for (const [from, to] of RANGES) {
      const r = await run('sales-tax-liability', { from, to, basis: 'accrual' });
      expect.soft(grand(r, 'openingBalance'), `opening ${from}`).toBe(await bsLine('2200', prevDay(from)));
      expect.soft(grand(r, 'balance'), `balance ${to}`).toBe(await bsLine('2200', to));
      expect.soft(r.balanced, `ties to GL ${from}..${to}`).toBe(true);
      const g = grandRow(r).cells;
      // Tax Credited is shown negative (credit memos reduce what is owed).
      expect.soft(add(g.openingBalance, g.collected, g.credited, g.adjustments, neg(g.paid)), `row adds up ${from}..${to}`).toBe(m2(g.balance));
    }
  });
});

// ---------------------------------------------------------------------------
// 5. GL report = registers = account balances
// ---------------------------------------------------------------------------

describe('general ledger, registers and account balances', () => {
  it('GL report ending balances = BS balances (BS accounts) and fiscal-YTD P&L (P&L accounts)', async () => {
    const ranges: [string, string][] = [['2025-07-01', '2026-06-30'], ['2026-07-01', '2026-09-30'], ['2026-01-01', '2026-03-31'], ['2026-06-01', '2026-06-30']];
    for (const [from, to] of ranges) {
      const gl = await run('general-ledger', { from, to });
      const bs = await balanceSheet(ctx, eod(to));
      for (const l of [...bs.assets, ...bs.liabilities, ...bs.equity]) {
        const r = rowById(gl, `gl:g:account:${l.accountId}:total`);
        if (!r && Money.of(l.amount).isZero()) continue;
        expect.soft(m2(r?.cells.balance), `GL ${from}..${to} account ${acctMeta.find((a) => a.id === l.accountId)?.code}`).toBe(m2(l.amount));
      }
      // P&L accounts open with their fiscal-year-to-date amount; the GL (like the TB) includes the
      // year-end closing entry, so the ending balance is the TB movement since the fiscal year start.
      const tbTo = await trialBalance(ctx, eod(to));
      const tbFy = await trialBalance(ctx, eod(prevDay(fyStart(from))));
      const tbNet = (tb: typeof tbTo, id: string) => {
        const r = tb.rows.find((x) => x.accountId === id);
        return r ? sub(r.debit, r.credit) : '0.00';
      };
      for (const a of acctMeta.filter((x) => x.type === 'revenue' || x.type === 'expense')) {
        const mv = sub(tbNet(tbTo, a.id), tbNet(tbFy, a.id));
        const natural = a.type === 'expense' ? mv : neg(mv);
        const r = rowById(gl, `gl:g:account:${a.id}:total`);
        if (!r && natural === '0.00') continue;
        expect.soft(m2(r?.cells.balance), `GL ${from}..${to} P&L account ${a.code}`).toBe(natural);
      }
    }
  });

  it('registers and generalLedger() closing balances = BS balances = cached account balances', async () => {
    for (const code of ['1000', '1010', '1020', '1050', '1200', '1300', '2000', '2100', '2200', '2300', '3900']) {
      for (const asOf of ['2025-12-31', '2026-06-30', '2026-09-30']) {
        const reg = await accountRegister(ctx, A[code], { to: eod(asOf) });
        expect.soft(reg.closingBalance, `register ${code} ${asOf}`).toBe(await bsLine(code, asOf));
        const [g] = await generalLedger(ctx, { accountId: A[code], to: eod(asOf) });
        expect.soft(m2(g?.closingBalance), `generalLedger() ${code} ${asOf}`).toBe(await bsLine(code, asOf));
        const tda = await run('transaction-detail-by-account', { accountId: A[code], to: asOf });
        expect.soft(grand(tda, 'amount'), `transaction detail ${code} ${asOf}`).toBe(await bsLine(code, asOf));
      }
      const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(and(eq(accounts.id, A[code]), eq(accounts.companyId, ctx.companyId)));
      const reg = await accountRegister(ctx, A[code]);
      expect.soft(m2(row.balance), `cached balance ${code}`).toBe(reg.closingBalance);
    }
  });

  it('journal / transaction lists balance and match the TB movement', async () => {
    for (const [from, to] of RANGES) {
      const j = await run('journal', { from, to });
      expect.soft(grand(j, 'debit'), `journal ${from}..${to}`).toBe(grand(j, 'credit'));
      expect.soft(j.balanced).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Cash basis internal consistency
// ---------------------------------------------------------------------------

describe('cash basis', () => {
  it('cash-basis BS balances, its NI = cash-basis P&L YTD, and the legacy cash BS agrees', async () => {
    for (const asOf of AS_OF) {
      const bs = await run('balance-sheet', { asOf, basis: 'cash' });
      const raw = await cashBasisBalanceSheet(ctx, eod(asOf));
      expect.soft(cell(bs, 'bs:assets:total'), `cash BS assets ${asOf}`).toBe(raw.totalAssets);
      expect.soft(raw.balanced, `cash BS balanced ${asOf}`).toBe(true);
      const legacy = await balanceSheetCashBasis(ctx, eod(asOf));
      const l = legacy as unknown as { totalAssets?: string; balanced?: boolean };
      if (l.totalAssets !== undefined) expect.soft(m2(l.totalAssets), `balanceSheetCashBasis() ${asOf}`).toBe(raw.totalAssets);
      // Cash itself is the same on both bases.
      const accrualBs = await run('balance-sheet', { asOf });
      expect.soft(cell(bs, 'bs:bank:total'), `bank ${asOf}`).toBe(cell(accrualBs, 'bs:bank:total'));
    }
  });

  it('cash-basis TB = cash-basis BS account balances', async () => {
    for (const asOf of ['2026-03-31', '2026-09-30']) {
      const tb = await run('trial-balance', { asOf, basis: 'cash' });
      const bs = await run('balance-sheet', { asOf, basis: 'cash' });
      for (const code of ['1000', '1050', '1300', '2200', '2300']) {
        const t = rowById(tb, `tb:a:${A[code]}`);
        const v = t ? sub(t.cells.debit, t.cells.credit) : '0.00';
        const a = acctMeta.find((x) => x.code === code)!;
        const natural = a.type === 'asset' ? v : neg(v);
        const bsRow = bs.rows.find((x) => x.id.endsWith(`:a:${A[code]}`));
        expect.soft(natural, `cash TB vs BS ${code} ${asOf}`).toBe(m2(bsRow?.cells.total));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Report builder, memorized reports, dashboard, budgets, consolidation
// ---------------------------------------------------------------------------

describe('report builder and memorized reports', () => {
  it('report builder by account = TB movement; by type = P&L (ranges without the close)', async () => {
    for (const [from, to] of RANGES) {
      const rb = await runReport(ctx, { from, to, groupBy: 'account' });
      const tbTo = await trialBalance(ctx, eod(to));
      const tbFrom = await trialBalance(ctx, eod(prevDay(from)));
      const net = (tb: typeof tbTo, id: string) => {
        const r = tb.rows.find((x) => x.accountId === id);
        return r ? sub(r.debit, r.credit) : '0.00';
      };
      for (const a of acctMeta) {
        const row = rb.rows.find((r) => r.key === a.id);
        expect.soft(m2(row?.net), `builder ${a.code} ${from}..${to}`).toBe(sub(net(tbTo, a.id), net(tbFrom, a.id)));
      }
      const byType = await runReport(ctx, { from, to, groupBy: 'type' });
      const containsClose = from <= '2026-06-30' && to >= '2026-06-30';
      if (!containsClose) {
        const rev = byType.rows.find((r) => r.key === 'revenue')?.net ?? '0';
        const exp = byType.rows.find((r) => r.key === 'expense')?.net ?? '0';
        const pl = await run('profit-loss', { from, to });
        expect.soft(neg(add(rev, exp)), `builder by type = P&L ${from}..${to}`).toBe(cell(pl, 'pl:net'));
      }
      const byMonth = await runReport(ctx, { from, to, groupBy: 'month' });
      expect.soft(byMonth.totals.debit, `builder by month ${from}..${to}`).toBe(rb.totals.debit);
    }
  });

  it('memorized reports reproduce the standard reports', async () => {
    const cases: [string, Record<string, string>][] = [
      ['profit-loss', { from: '2025-07-01', to: '2026-06-30' }],
      ['balance-sheet', { asOf: '2026-06-30' }],
      ['ar-aging-summary', { asOf: '2026-03-31' }],
      ['profit-loss', { from: '2026-07-01', to: '2026-09-30', basis: 'cash' }],
    ];
    for (const [key, params] of cases) {
      const mem = await saveMemorizedReport(ctx, { name: `Memo ${key} ${JSON.stringify(params)}`, reportType: key, config: { params } });
      const a = await runMemorizedReport(ctx, mem.id);
      const b = await run(key, params);
      expect.soft(JSON.stringify(a.rows), `memorized ${key}`).toBe(JSON.stringify(b.rows));
    }
    const custom = await saveMemorizedReport(ctx, { name: 'Custom by type', reportType: 'custom', config: { from: '2026-07-01', to: '2026-09-30', groupBy: 'type' } });
    const c = await runMemorizedReport(ctx, custom.id);
    const rb = await runReport(ctx, { from: '2026-07-01', to: '2026-09-30', groupBy: 'type' });
    expect.soft(m2(grandRow(c).cells.debit), 'memorized custom').toBe(rb.totals.debit);
  });
});

describe('dashboard KPIs', () => {
  it('KPIs = the reports (today)', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const ins = await getDashboardInsights(ctx, now);
    const pl = await run('profit-loss', { from: fyStart(today), to: today });
    // The tile is all revenue accounts (Income + Other Income).
    expect.soft(ins.kpis.revenueYtd, 'revenue YTD').toBe(add(cell(pl, 'pl:income:total'), cell(pl, 'pl:other_income:total')));
    expect.soft(ins.kpis.netProfitYtd, 'net profit YTD').toBe(cell(pl, 'pl:net'));
    expect.soft(ins.kpis.cash, 'cash').toBe(await cashAt(today));
    expect.soft(ins.kpis.accountsReceivable, 'A/R').toBe(await bsLine('1200', today));
    expect.soft(ins.kpis.accountsPayable, 'A/P').toBe(await bsLine('2000', today));
    const aging = await run('ar-aging-summary', { asOf: today });
    expect.soft(ins.arAging.total, 'A/R aging tile').toBe(grand(aging, 'total'));
    // P&L trend (last 6 months) = P&L by month.
    for (const p of ins.plTrend) {
      const [y, mo] = p.month.split('-').map(Number);
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      const to = last > today ? today : last;
      const mpl = await run('profit-loss', { from: `${p.month}-01`, to });
      expect.soft(p.net, `trend ${p.month}`).toBe(cell(mpl, 'pl:net'));
    }
  });
});

describe('budget vs actual', () => {
  // Review 4 finding: budgets compared calendar Jan–Dec actuals, not the company's fiscal year.
  it('budget vs actual actuals = the P&L for the budget fiscal year', async () => {
    // FY2026 = 07/01/2025 – 06/30/2026 (June 30 year end).
    const fy = await run('profit-loss', { from: '2025-07-01', to: '2026-06-30' });
    const bva = await budgetVsActual(ctx, S.budget);
    for (const code of ['4100', '6400']) {
      const row = bva.rows.find((r) => r.accountId === A[code]);
      const plRow = fy.rows.find((x) => x.id.endsWith(`:a:${A[code]}`) && x.kind === 'data');
      expect.soft(m2(row?.actual), `budgetVsActual() actual ${code}`).toBe(m2(plRow?.cells.total));
    }
    const rep = await run('budget-vs-actual-report', { budgetId: S.budget });
    for (const code of ['4100', '6400']) {
      const r = rep.rows.find((x) => x.id.endsWith(`:a:${A[code]}`) && x.kind === 'data');
      const plRow = fy.rows.find((x) => x.id.endsWith(`:a:${A[code]}`) && x.kind === 'data');
      expect.soft(m2(r?.cells.total_act), `Budget vs. Actual report actual ${code}`).toBe(m2(plRow?.cells.total));
    }
    const monthly = await run('budget-vs-actual-report', { budgetId: S.budget, columns: 'month' });
    const firstCol = monthly.columns.find((c) => c.key.endsWith('_act'));
    expect.soft(firstCol?.header ?? '', 'first budget month is the first fiscal month').toMatch(/Jul 2025/);
  });
});

describe('consolidated reports for one company = its standalone reports', () => {
  it('combined TB / P&L by month / cash flow / consolidated P&L and BS', async () => {
    for (const asOf of ['2026-03-31', '2026-06-30', '2026-09-30']) {
      const tb = await run('trial-balance', { asOf });
      const ctb = await run('combined-trial-balance', { asOf });
      expect.soft(m2(grandRow(ctb).cells.total_dr), `combined TB ${asOf}`).toBe(grand(tb, 'debit'));
      const cbs = await consolidatedBalanceSheet(ctx, eod(asOf));
      const bs = await run('balance-sheet', { asOf });
      expect.soft(cbs.consolidated.totalAssets, `consolidated BS ${asOf}`).toBe(cell(bs, 'bs:assets:total'));
      expect.soft(cbs.consolidated.currentYearNetIncome, `consolidated BS NI ${asOf}`).toBe(cell(bs, 'bs:ni'));
    }
    for (const [from, to] of RANGES) {
      const pl = await run('profit-loss', { from, to });
      const cpl = await run('combined-pl-by-month', { from, to });
      expect.soft(cell(cpl, 'pl:net'), `combined P&L by month ${from}..${to}`).toBe(cell(pl, 'pl:net'));
      const cplCash = await run('combined-pl-by-month', { from, to, basis: 'cash' });
      const plCash = await run('profit-loss', { from, to, basis: 'cash' });
      expect.soft(cell(cplCash, 'pl:net'), `combined P&L by month cash ${from}..${to}`).toBe(cell(plCash, 'pl:net'));
      const cons = await consolidatedPL(ctx, { from: d(from), to: eod(to) });
      expect.soft(cons.consolidated.netIncome, `consolidatedPL ${from}..${to}`).toBe(cell(pl, 'pl:net'));
      const scf = await run('statement-of-cash-flows', { from, to });
      const ccf = await run('combined-cash-flow', { from, to });
      expect.soft(cell(ccf, 'ccf:net'), `combined cash flow ${from}..${to}`).toBe(cell(scf, 'scf:net'));
      const cf = await cashFlow(ctx, { from: d(from), to: eod(to) });
      expect.soft(cf.netCashChange, `cashFlow() ${from}..${to}`).toBe(cell(scf, 'scf:net'));
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Every catalog report runs
// ---------------------------------------------------------------------------

describe('report catalog', () => {
  it('every report in catalog.ts runs on this company without throwing', async () => {
    const failures: string[] = [];
    for (const e of REPORT_CATALOG) {
      const params: Record<string, string> = { from: '2025-07-01', to: '2026-06-30', asOf: '2026-06-30' };
      if (e.controls.includes('budget')) params.budgetId = S.budget;
      try {
        const r = await run(e.key, params);
        if (!Array.isArray(r.rows)) failures.push(`${e.key}: no rows`);
        if (e.basis) await run(e.key, { ...params, basis: 'cash' });
      } catch (err) {
        failures.push(`${e.key}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. More pairs: expenses by vendor, account listing, lists, per-name subledgers, purchases
// ---------------------------------------------------------------------------

describe('more report pairs', () => {
  it('expenses by vendor (summary / detail) = P&L COGS + expenses + other expenses, both bases', async () => {
    for (const [from, to] of RANGES) {
      for (const basis of ['accrual', 'cash']) {
        const pl = await run('profit-loss', { from, to, basis });
        const exp = add(cell(pl, 'pl:cogs:total'), cell(pl, 'pl:expense:total'), cell(pl, 'pl:other_expense:total'));
        const s = await run('expenses-by-vendor-summary', { from, to, basis });
        expect.soft(grand(s, 'amount'), `expenses by vendor summary ${basis} ${from}..${to}`).toBe(exp);
        const dt = await run('expenses-by-vendor-detail', { from, to, basis });
        expect.soft(grand(dt, 'amount'), `expenses by vendor detail ${basis} ${from}..${to}`).toBe(exp);
      }
    }
  });

  it('account listing and balance sheet detail balances = BS balances', async () => {
    for (const asOf of ['2025-12-31', '2026-06-30', '2026-09-30']) {
      const al = await run('account-listing', { asOf });
      const bs = await balanceSheet(ctx, eod(asOf));
      for (const l of [...bs.assets, ...bs.liabilities, ...bs.equity]) {
        expect.soft(cell(al, `al:${l.accountId}`, 'balance'), `account listing ${asOf} ${acctMeta.find((a) => a.id === l.accountId)?.code}`).toBe(m2(l.amount));
      }
    }
    for (const [from, to] of [['2025-07-01', '2026-06-30'], ['2026-07-01', '2026-09-30'], ['2026-03-01', '2026-03-31']] as [string, string][]) {
      const bsd = await run('balance-sheet-detail', { from, to });
      const bs = await balanceSheet(ctx, eod(to));
      for (const l of [...bs.assets, ...bs.liabilities, ...bs.equity]) {
        const r = rowById(bsd, `bsd:g:account:${l.accountId}:total`);
        if (!r && Money.of(l.amount).isZero()) continue;
        expect.soft(m2(r?.cells.balance), `BS detail ${from}..${to} ${acctMeta.find((a) => a.id === l.accountId)?.code}`).toBe(m2(l.amount));
      }
    }
  });

  it('transaction list by date total = journal debits', async () => {
    for (const [from, to] of RANGES) {
      const tl = await run('transaction-list-by-date', { from, to });
      const j = await run('journal', { from, to });
      expect.soft(grand(tl, 'amount'), `transaction list ${from}..${to}`).toBe(grand(j, 'debit'));
    }
  });

  it('per customer / vendor: aging summary = customer / vendor balance summary', async () => {
    for (const asOf of ['2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30']) {
      const ag = await run('ar-aging-summary', { asOf });
      const cb = await run('customer-balance-summary', { asOf });
      for (const r of cb.rows.filter((x) => x.kind === 'data')) {
        const name = String(r.cells.label);
        const a = ag.rows.find((x) => x.kind === 'data' && String(x.cells.label) === name);
        expect.soft(m2(a?.cells.total), `A/R ${name} ${asOf}`).toBe(m2(r.cells.balance));
      }
      const apg = await run('ap-aging-summary', { asOf });
      const vb = await run('vendor-balance-summary', { asOf });
      for (const r of vb.rows.filter((x) => x.kind === 'data')) {
        const name = String(r.cells.label);
        const a = apg.rows.find((x) => x.kind === 'data' && String(x.cells.label) === name);
        expect.soft(m2(a?.cells.total), `A/P ${name} ${asOf}`).toBe(m2(r.cells.balance));
      }
    }
  });

  // Fails while Sales by Customer leaves out the invoice header discount (P&L by Job is right).
  it('P&L by Job income per customer = sales by customer per customer (home-currency customers)', async () => {
    for (const [from, to] of [['2025-07-01', '2026-06-30'], ['2026-07-01', '2026-09-30']] as [string, string][]) {
      const pj = await run('profit-loss-by-job', { from, to });
      const sbc = await run('sales-by-customer-summary', { from, to });
      for (const col of pj.columns.filter((c) => /^c\d+$/.test(c.key))) {
        if (col.header === 'No customer:job' || col.header.startsWith('EuroCo')) continue;
        const s = sbc.rows.find((x) => x.kind === 'data' && String(x.cells.label) === col.header);
        expect.soft(cell(pj, 'pl:income:total', col.key), `P&L by job ${col.header} ${from}..${to}`).toBe(m2(s?.cells.amount));
      }
    }
  });

  it('purchases by item / vendor = the item lines bought', async () => {
    // SUP-1 5,250 + SUP-2 2,200 + SUP-3 100 of inventory items.
    for (const key of ['purchases-by-item-summary', 'purchases-by-item-detail', 'purchases-by-vendor-summary']) {
      const r = await run(key, { from: '2025-08-01', to: '2026-09-30' });
      expect.soft(JSON.stringify(grandRow(r)?.cells ?? {}), key).toContain('"7550.00"');
    }
  });

  it('comparison columns: previous period P&L and previous month BS', async () => {
    const cmp = await run('profit-loss', { from: '2026-07-01', to: '2026-09-30', compare: 'prev_period' });
    const prev = await run('profit-loss', { from: '2026-04-01', to: '2026-06-30' });
    expect.soft(cell(cmp, 'pl:net', 'prev'), 'prev period P&L').toBe(cell(prev, 'pl:net'));
    expect.soft(cell(cmp, 'pl:net', 'chg')).toBe(sub(cell(cmp, 'pl:net', 'cur'), cell(cmp, 'pl:net', 'prev')));
    const bsc = await run('balance-sheet', { asOf: '2026-07-31', compare: 'prev_period' });
    const bsp = await run('balance-sheet', { asOf: '2026-06-30' });
    expect.soft(cell(bsc, 'bs:assets:total', 'prev'), 'prev month BS assets').toBe(cell(bsp, 'bs:assets:total'));
    expect.soft(cell(bsc, 'bs:ni', 'prev'), 'prev month BS NI').toBe(cell(bsp, 'bs:ni'));
  });
});

describe('payroll report family and the reconciliation', () => {
  it('payroll detail / earnings / item detail / by payee / 941 / W-2 = payroll summary', async () => {
    for (const [from, to] of RANGES) {
      const r = { from: d(from), to: eod(to) };
      const ps = await payrollSummary(ctx, r);
      const det = await payrollDetail(ctx, r);
      expect.soft(add(...det.rows.map((x) => x.gross)), `payroll detail gross ${from}..${to}`).toBe(ps.totals.gross);
      expect.soft(add(...det.rows.map((x) => x.net)), `payroll detail net ${from}..${to}`).toBe(ps.totals.net);
      const ee = await employeeEarningsSummary(ctx, r);
      expect.soft(ee.totalGross, `earnings summary gross ${from}..${to}`).toBe(ps.totals.gross);
      expect.soft(ee.totalNet, `earnings summary net ${from}..${to}`).toBe(ps.totals.net);
      const tp = await payrollTransactionsByPayee(ctx, r);
      expect.soft(tp.totalGross, `transactions by payee gross ${from}..${to}`).toBe(ps.totals.gross);
      const items = await payrollItemDetail(ctx, r);
      const earn = items.groups.filter((g) => g.kind === 'earning').map((g) => g.total);
      expect.soft(add(...earn), `item detail earnings ${from}..${to}`).toBe(ps.totals.gross);
    }
    for (const [q, from, to] of [[1, '2026-01-01', '2026-03-31'], [3, '2026-07-01', '2026-09-30'], [4, '2025-10-01', '2025-12-31']] as [1 | 3 | 4, string, string][]) {
      const year = Number(from.slice(0, 4));
      const f = await form941Data(ctx, { quarter: q, year });
      const ps = await payrollSummary(ctx, { from: d(from), to: eod(to) });
      expect.soft(f.totals.grossPay, `941 Q${q} ${year} gross`).toBe(ps.totals.gross);
    }
    const ps2025 = await payrollSummary(ctx, { from: d('2025-01-01'), to: eod('2025-12-31') });
    const w2s = await Promise.all([S.emp1, S.emp2].map((employeeId) => w2Data(ctx, { employeeId, year: 2025 })));
    const box1 = add(...w2s.map((w) => w.wages));
    expect.soft(box1, 'W-2 box 1 (2025)').toBe(ps2025.totals.federalTaxableWages);
  });

  it('reconciliation: cleared balance = statement; cleared + uncleared = the register balance', async () => {
    const rep = await getReconciliationReport(ctx, S.recon);
    expect.soft(rep.clearedBalance).toBe(S.reconBalance);
    expect.soft(rep.difference).toBe('0.00');
    const cleared = await run('transaction-detail-by-account', { accountId: A['1000'], to: '2026-03-31', cleared: 'cleared' });
    const uncleared = await run('transaction-detail-by-account', { accountId: A['1000'], to: '2026-03-31', cleared: 'uncleared' });
    expect.soft(grand(cleared, 'amount'), 'cleared lines').toBe(S.reconBalance);
    expect.soft(add(grand(cleared, 'amount'), grand(uncleared, 'amount')), 'cleared + uncleared').toBe(await bsLine('1000', '2026-03-31'));
  });
});

describe('detail and working-capital pairs', () => {
  it('customer / vendor balance detail = balance summary; collections = past-due aging', async () => {
    for (const asOf of ['2026-03-31', '2026-09-30']) {
      const cbs = await run('customer-balance-summary', { asOf });
      const cbd = await run('customer-balance-detail', { to: asOf, asOf });
      expect.soft(grand(cbd, 'amount'), `customer balance detail ${asOf}`).toBe(grand(cbs, 'balance'));
      const vbs = await run('vendor-balance-summary', { asOf });
      const vbd = await run('vendor-balance-detail', { to: asOf, asOf });
      expect.soft(grand(vbd, 'amount'), `vendor balance detail ${asOf}`).toBe(grand(vbs, 'balance'));
      const ag = await run('ar-aging-summary', { asOf });
      const pastDue = sub(grand(ag, 'total'), grand(ag, 'current'));
      const col = await run('collections-report', { asOf });
      expect.soft(JSON.stringify(grandRow(col)?.cells ?? {}), `collections ${asOf} (past due ${pastDue})`).toContain(`"${pastDue}"`);
    }
  });

  it('cash flow A/R, A/P and inventory lines = the balance sheet changes', async () => {
    for (const [from, to] of RANGES) {
      const scf = await run('statement-of-cash-flows', { from, to });
      const before = prevDay(from);
      expect.soft(cell(scf, 'scf:ar'), `SCF A/R ${from}..${to}`).toBe(neg(sub(await bsLine('1200', to), await bsLine('1200', before))));
      expect.soft(cell(scf, 'scf:ap'), `SCF A/P ${from}..${to}`).toBe(sub(await bsLine('2000', to), await bsLine('2000', before)));
      expect.soft(cell(scf, 'scf:inv'), `SCF inventory ${from}..${to}`).toBe(neg(sub(await bsLine('1300', to), await bsLine('1300', before))));
    }
  });

  it('P&L by Job income per customer = sales by customer (cash basis)', async () => {
    const [from, to] = ['2025-07-01', '2026-06-30'];
    const pj = await run('profit-loss-by-job', { from, to, basis: 'cash' });
    const sbc = await run('sales-by-customer-summary', { from, to, basis: 'cash' });
    for (const col of pj.columns.filter((c) => /^c\d+$/.test(c.key))) {
      if (col.header === 'No customer:job' || col.header.startsWith('EuroCo')) continue;
      const s = sbc.rows.find((x) => x.kind === 'data' && String(x.cells.label) === col.header);
      expect.soft(cell(pj, 'pl:income:total', col.key), `P&L by job (cash) ${col.header}`).toBe(m2(s?.cells.amount));
    }
  });
});
