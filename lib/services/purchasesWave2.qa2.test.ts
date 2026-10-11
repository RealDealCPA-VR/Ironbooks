/**
 * wave2 purchases — independent QA, re-test round 1. Adversarial checks on the round-1 fixes:
 *  - PO line ownership (create + update, items + accounts, rollback)
 *  - vendor currency lock (vendor credits / POs / item receipts count; voided ones do not)
 *  - Loan Manager payment dates clamp at month end (leap years, quarterly, annual, monotonic)
 *  - Loan Manager bills locked against edits; void puts principal back on the schedule
 *  - Loan Manager home-currency guard (no lender + EUR account, EUR account override)
 *  - home-currency-only documents (vendor credit retarget, deposit cash back, transfer edit,
 *    cross-company transfer)
 *  - A/P aging + aging detail of foreign bills in home currency (as-of, discounts, voids)
 * Every scenario re-checks TB / BS balance and A/P control == home subledger.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull, ne } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  vendors,
  items,
  bills,
  billPaymentApplications,
  billPayments,
  vendorCredits,
  purchaseOrders,
  loanPayments,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { apAging, apAgingDetail } from './reportsExtra';
import { postJournalEntry } from './posting';
import { createBill, updateBill, voidBill, getBill } from './bills';
import { payBills, voidBillPayment } from './billPayments';
import { createVendorCredit, updateVendorCredit, voidVendorCredit } from './vendorCredits';
import { createTransfer, updateTransfer } from './transfers';
import { createPurchaseOrder, updatePurchaseOrder, getPurchaseOrder } from './purchaseOrders';
import { createItemReceipt } from './itemReceipts';
import { createDeposit } from './deposits';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createVendor, updateVendor } from './vendors';
import { createLoan, getLoan, setUpLoanPayment, paymentDate } from './loans';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-purchases-wave2-qa2');
let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext;
const acct: Record<string, string> = {};
let otherAcct: string;
let otherItem: string;

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);
let vendorSeq = 0;

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}

async function mkVendor(extra: Record<string, unknown> = {}) {
  vendorSeq += 1;
  const [v] = await db
    .insert(vendors)
    .values({ companyId: ctx.companyId, displayName: `QA2 Vendor ${vendorSeq}`, ...extra } as never)
    .returning();
  return v;
}

async function apSubledgerHome(): Promise<string> {
  const rows = await db
    .select()
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), ne(bills.status, 'void')));
  let sum = Money.zero();
  for (const b of rows) {
    if (!b.currency) {
      sum = sum.plus(Money.of(b.balanceDue));
      continue;
    }
    const anchor = Money.round2(Money.of(b.total).times(Money.of(b.exchangeRate ?? 1)));
    const apps = await db
      .select({ home: billPaymentApplications.amountHome, applied: billPaymentApplications.amountApplied })
      .from(billPaymentApplications)
      .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
      .where(and(eq(billPaymentApplications.billId, b.id), isNull(billPayments.voidedAt)));
    const relieved = apps.reduce((s, a) => s.plus(Money.of(a.home ?? a.applied)), Money.zero());
    sum = sum.plus(anchor.minus(relieved));
  }
  const vcs = await db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.companyId, ctx.companyId), ne(vendorCredits.status, 'void')));
  for (const vc of vcs) sum = sum.minus(Money.of(vc.unapplied));
  return sum.toFixed(2);
}

async function invariants() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(ctx);
  expect(Money.of(bs.totalAssets).toFixed(2)).toBe(
    Money.of(bs.totalLiabilities).plus(Money.of(bs.totalEquity)).toFixed(2),
  );
  expect(await apSubledgerHome()).toBe(await bal('2000'));
}

/** A/P aging (summary + detail) both tie to the A/P control account. */
async function agingTies(asOf: Date) {
  const aging = await apAging(ctx, asOf);
  const detail = await apAgingDetail(ctx, asOf);
  expect(Money.of(aging.totals.total).toFixed(2)).toBe(await bal('2000'));
  expect(Money.of(detail.total).toFixed(2)).toBe(await bal('2000'));
}

describe('wave2 purchases — QA round 2', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'w2p-qa2@test.local', name: 'QA2', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Purchases QA2 Co', ownerId: user.id }).returning();
    const [company2] = await db.insert(companies).values({ name: 'Other QA2 Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctx2 = { db, companyId: company2.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Petty Cash', 'asset', 'checking'],
      ['1020', 'Euro Bank', 'asset', 'checking'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2600', 'Truck Loan', 'liability', 'long_term_liability'],
      ['2610', 'No-lender Loan', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4900', 'Other Income', 'revenue', 'other_income'],
      ['4950', 'Discounts Taken', 'revenue', 'other_income'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
      ['6800', 'Interest Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype } as never)).id;
    }
    otherAcct = (await createAccount(ctx2, { code: '6300', name: 'Other supplies', type: 'expense' as never, subtype: 'operating_expenses' } as never)).id;
    const [oi] = await db
      .insert(items)
      .values({ companyId: ctx2.companyId, name: 'Other widget', type: 'non_inventory', expenseAccountId: otherAcct } as never)
      .returning();
    otherItem = oi.id;

    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '50000.00' },
        { accountId: acct['3000'], credit: '50000.00' },
      ],
    });
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' } as never);
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.0712' } as never);
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; next run wipes the dir first. */
    }
  });

  // ------------------------------------------------------------------ PO ownership
  it('PO create/update: other-company items and accounts refused; a refused edit changes nothing', async () => {
    const v = await mkVendor();
    await expect(
      createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ accountId: otherAcct, quantity: '1', rate: '5' }] } as never),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: otherItem, quantity: '1', rate: '5' }] } as never),
    ).rejects.toBeInstanceOf(ServiceError);
    const before = await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, ctx.companyId));
    expect(before).toHaveLength(0);

    const po = await createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ accountId: acct['6300'], quantity: '2', rate: '5' }] } as never);
    // A mix of a good line and a foreign line is refused as a whole.
    await expect(
      updatePurchaseOrder(ctx, po.id, {
        vendorId: v.id,
        date: d('2026-02-01'),
        lines: [
          { accountId: acct['6300'], quantity: '9', rate: '9' },
          { itemId: otherItem, quantity: '1', rate: '1' },
        ],
      } as never),
    ).rejects.toBeInstanceOf(ServiceError);
    const after = await getPurchaseOrder(ctx, po.id);
    expect(Money.of(after.total).toFixed(2)).toBe('10.00');
    expect(after.lines).toHaveLength(1);
    // The same account repeated on two lines is fine (dedupe must not break the count check).
    const ok = await updatePurchaseOrder(ctx, po.id, {
      vendorId: v.id,
      date: d('2026-02-01'),
      lines: [
        { accountId: acct['6300'], quantity: '1', rate: '5' },
        { accountId: acct['6300'], quantity: '1', rate: '6' },
      ],
    } as never);
    expect(Money.of(ok.total).toFixed(2)).toBe('11.00');
  });

  // ------------------------------------------------------------------ vendor currency lock
  it('vendor currency lock: open PO / item receipt / vendor credit lock it; a voided vendor credit does not', async () => {
    const withPo = await createVendor(ctx, { displayName: 'QA2 PO vendor' });
    await createPurchaseOrder(ctx, { vendorId: withPo.id, date: d('2026-02-02'), lines: [{ accountId: acct['6300'], quantity: '1', rate: '1' }] } as never);
    await expect(updateVendor(ctx, withPo.id, { currency: 'EUR' })).rejects.toMatchObject({ code: 'CONFLICT' });

    const [stock] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'QA2 gadget', type: 'inventory', assetAccountId: acct['1300'], quantityOnHand: '0', averageCost: '0' } as never)
      .returning();
    const withIr = await createVendor(ctx, { displayName: 'QA2 IR vendor' });
    await createItemReceipt(ctx, { vendorId: withIr.id, date: d('2026-02-02'), lines: [{ itemId: stock.id, quantity: '1', unitCost: '3' }] });
    await expect(updateVendor(ctx, withIr.id, { currency: 'EUR' })).rejects.toMatchObject({ code: 'CONFLICT' });

    const withVc = await createVendor(ctx, { displayName: 'QA2 VC vendor' });
    const vc = await createVendorCredit(ctx, { vendorId: withVc.id, date: d('2026-02-02'), lines: [{ accountId: acct['6300'], amount: '4.00' }] });
    await expect(updateVendor(ctx, withVc.id, { currency: 'EUR' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await voidVendorCredit(ctx, vc.id);
    const changed = await updateVendor(ctx, withVc.id, { currency: 'EUR' });
    expect((changed as { currency?: string | null }).currency).toBe('EUR');
    await invariants();
  });

  it('a home vendor credit cannot be retargeted to a EUR vendor (nothing posted, A/P unchanged)', async () => {
    const home = await mkVendor();
    const eur = await mkVendor({ currency: 'EUR' });
    const vc = await createVendorCredit(ctx, { vendorId: home.id, date: d('2026-02-03'), lines: [{ accountId: acct['6300'], amount: '12.00' }] });
    const ap = await bal('2000');
    await expect(
      updateVendorCredit(ctx, vc.id, { vendorId: eur.id, date: d('2026-02-03'), lines: [{ accountId: acct['6300'], amount: '12.00' }] }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(await bal('2000')).toBe(ap);
    const [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(row.vendorId).toBe(home.id);
    await invariants();
  });

  // ------------------------------------------------------------------ loans: dates
  it('payment dates clamp to month end (leap years, quarterly, annual, semi-monthly) and always increase', () => {
    const seq = (first: string, n: number, ppy: number) =>
      Array.from({ length: n }, (_, i) => ymd(paymentDate(d(first), i + 1, ppy)));
    expect(seq('2028-01-31', 4, 12)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30']);
    expect(seq('2026-11-30', 3, 4)).toEqual(['2026-11-30', '2027-02-28', '2027-05-30']);
    expect(seq('2028-02-29', 5, 1)).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
    // Clamping must not drift: the 31st comes back after a short month.
    expect(seq('2026-08-31', 4, 12)).toEqual(['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30']);
    for (const ppy of [1, 2, 4, 6, 12, 24, 26, 52]) {
      for (const start of ['2026-01-28', '2026-01-29', '2026-01-30', '2026-01-31', '2027-12-31']) {
        const dates = Array.from({ length: 30 }, (_, i) => paymentDate(d(start), i + 1, ppy).getTime());
        for (let i = 1; i < dates.length; i++) expect(dates[i]).toBeGreaterThan(dates[i - 1]);
        expect(ymd(paymentDate(d(start), 1, ppy))).toBe(start);
      }
    }
  });

  // ------------------------------------------------------------------ loans: bill lock + void
  it('Loan Manager bill: memo-only edit refused, void restores principal; loan balance == liability throughout', async () => {
    await postJournalEntry(ctx, {
      date: d('2026-01-04'),
      description: 'Truck loan proceeds',
      lines: [
        { accountId: acct['1000'], debit: '12000.00' },
        { accountId: acct['2600'], credit: '12000.00' },
      ],
    });
    const lender = await mkVendor();
    const loan = await createLoan(ctx, {
      name: 'Truck QA2',
      lenderVendorId: lender.id,
      liabilityAccountId: acct['2600'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1000'],
      originalAmount: '12000',
      annualRate: '6',
      termMonths: 24,
      originDate: d('2026-01-04'),
      firstPaymentDate: d('2026-01-31'),
    });
    const lp = await setUpLoanPayment(ctx, loan.id, { kind: 'bill' });
    expect((await getLoan(ctx, loan.id)).balance).toBe(await bal('2600'));
    const bill = await getBill(ctx, lp.billId!);
    await expect(
      updateBill(ctx, bill.id, {
        vendorId: lender.id,
        billNumber: bill.billNumber,
        date: bill.date,
        memo: 'just a memo',
        lines: bill.lines.map((l: { accountId: string; amount: string; description?: string | null }) => ({ accountId: l.accountId, amount: l.amount, description: l.description })),
      } as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Paying the loan bill is still allowed and does not move the liability.
    const liab = await bal('2600');
    await payBills(ctx, { vendorId: lender.id, date: d('2026-02-05'), method: 'ach', paymentAccountId: acct['1000'], applications: [{ billId: bill.id, amountApplied: '1.00' }] });
    expect(await bal('2600')).toBe(liab);
    await invariants();

    // A second payment is dated one month later, clamped to Feb 28.
    const l2 = await getLoan(ctx, loan.id);
    if (l2.next) expect(ymd(new Date(l2.next.date))).toBe('2026-02-28');

    // Void (after removing the payment) puts the principal back.
    const pays = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.billId, bill.id));
    for (const p of pays) await voidBillPayment(ctx, p.billPaymentId);
    await voidBill(ctx, bill.id);
    const after = await getLoan(ctx, loan.id);
    expect(after.balance).toBe('12000.00');
    expect(after.balance).toBe(await bal('2600'));
    await invariants();
  });

  // ------------------------------------------------------------------ loans: home currency guard
  it('Loan Manager: no lender + EUR payment account, or an EUR override, is refused atomically', async () => {
    await postJournalEntry(ctx, {
      date: d('2026-01-05'),
      description: 'No-lender loan proceeds',
      lines: [
        { accountId: acct['1000'], debit: '600.00' },
        { accountId: acct['2610'], credit: '600.00' },
      ],
    });
    const loan = await createLoan(ctx, {
      name: 'Euro-paid QA2',
      liabilityAccountId: acct['2610'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1020'],
      originalAmount: '600',
      annualRate: '5',
      termMonths: 6,
      originDate: d('2026-01-05'),
      firstPaymentDate: d('2026-02-05'),
    }).catch((e) => {
      // Refusing a foreign payment account at setup is also acceptable.
      expect(e).toBeInstanceOf(ServiceError);
      return null;
    });
    const eurBank = await bal('1020');
    if (loan) {
      await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check' })).rejects.toBeInstanceOf(ServiceError);
      expect(await db.select().from(loanPayments).where(eq(loanPayments.loanId, loan.id))).toHaveLength(0);
    }
    const home = await createLoan(ctx, {
      name: 'Home-paid QA2',
      liabilityAccountId: acct['2610'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1000'],
      originalAmount: '600',
      annualRate: '5',
      termMonths: 6,
      originDate: d('2026-01-05'),
      firstPaymentDate: d('2026-02-05'),
    });
    await expect(setUpLoanPayment(ctx, home.id, { kind: 'check', paymentAccountId: acct['1020'] } as never)).rejects.toBeInstanceOf(ServiceError);
    expect(await db.select().from(loanPayments).where(eq(loanPayments.loanId, home.id))).toHaveLength(0);
    expect(await bal('1020')).toBe(eurBank);
    expect(await bal('2610')).toBe('600.00');
    await invariants();
  });

  // ------------------------------------------------------------------ home-currency-only banking docs
  it('deposit cash back to a EUR account, transfer edited onto a EUR account, and cross-company transfers are refused', async () => {
    const chk = await bal('1000');
    await expect(
      createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: d('2026-02-10'),
        extraLines: [{ accountId: acct['4900'], amount: '50.00' }],
        cashBack: { accountId: acct['1020'], amount: '10.00' },
      } as never),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(await bal('1000')).toBe(chk);

    const t = await createTransfer(ctx, { fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '25.00', date: d('2026-02-10') });
    await expect(
      updateTransfer(ctx, t.id, { fromAccountId: acct['1000'], toAccountId: acct['1020'], amount: '25.00', date: d('2026-02-10') }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(await bal('1010')).toBe('25.00');
    expect(await bal('1020')).toBe('0.00');

    await expect(
      createTransfer(ctx, { fromAccountId: acct['1000'], toAccountId: otherAcct, amount: '1.00', date: d('2026-02-10') }),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      createTransfer(ctx2, { fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '1.00', date: d('2026-02-10') }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(await bal('1010')).toBe('25.00');
    await invariants();
  });

  // ------------------------------------------------------------------ A/P aging in home currency
  it('A/P aging (summary + detail) ties to A/P for foreign bills: as-of before/after payments, discounts, voids', async () => {
    const v = await mkVendor({ currency: 'EUR', terms: '2_10_net_30' });
    const b1 = await createBill(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '333.33' }] });
    const b2 = await createBill(ctx, { vendorId: v.id, date: d('2026-03-02'), exchangeRate: '1.1', lines: [{ accountId: acct['6300'], amount: '50.00' }] } as never);
    await invariants();
    await agingTies(d('2026-12-31'));

    // Partial payment at a different rate with a discount.
    const p1 = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-03-05'),
      method: 'ach',
      paymentAccountId: acct['1000'],
      discountAccountId: acct['4950'],
      exchangeRate: '1.25',
      applications: [{ billId: b1.id, amountApplied: '100.00', discountTaken: '6.67' }],
    });
    await invariants();
    await agingTies(d('2026-12-31'));
    // As of the day before the payment, b1 is aged at its full home amount (357.06).
    const early = await apAgingDetail(ctx, d('2026-03-04'));
    const b1Early = early.rows.find((r) => r.docId === b1.id)!;
    expect(Money.of(b1Early.openBalance).toFixed(2)).toBe(Money.round2(Money.of('333.33').times('1.0712')).toFixed(2));
    const b1Late = (await apAgingDetail(ctx, d('2026-12-31'))).rows.find((r) => r.docId === b1.id)!;
    // 357.06 - round2(106.67 x 1.0712 = 114.2649) = 357.06 - 114.26 = 242.80
    expect(Money.of(b1Late.openBalance).toFixed(2)).toBe('242.80');

    // Pay b2 in full: it drops out of the aging; aging still ties.
    await payBills(ctx, { vendorId: v.id, date: d('2026-03-06'), method: 'ach', paymentAccountId: acct['1000'], exchangeRate: '0.95', applications: [{ billId: b2.id, amountApplied: '50.00' }] });
    expect((await apAgingDetail(ctx, d('2026-12-31'))).rows.find((r) => r.docId === b2.id)).toBeUndefined();
    await invariants();
    await agingTies(d('2026-12-31'));

    // Void the partial payment: b1 is back to its full home amount.
    await voidBillPayment(ctx, p1.id);
    const back = (await apAgingDetail(ctx, d('2026-12-31'))).rows.find((r) => r.docId === b1.id)!;
    expect(Money.of(back.openBalance).toFixed(2)).toBe('357.06');
    await invariants();
    await agingTies(d('2026-12-31'));
    expect((await getBill(ctx, b1.id)).balanceDue).toBe('333.33');
  });
});
