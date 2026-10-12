/**
 * Team ledger fix — TESTER (independent adversarial QA) for P0 I11: named A/R and A/P journal-entry
 * lines are open items that can be paid and applied (QuickBooks "General Journal" rows).
 *
 * Attacks the doer's implementation (journalApplications.ts + payments / billPayments / journal):
 *  - penny-exact partial payments, the same line listed twice, over-application;
 *  - all-or-nothing rollback when one part of a Receive Payments / Pay Bills save is invalid;
 *  - multi-company isolation (company B can't see, pay or apply company A's journal lines);
 *  - lines that are not named General Journal A/R / A/P lines (no name, document postings);
 *  - documents that carry a journal credit can't be voided / shrunk out from under it;
 *  - closing date on unapply; voiding the entry once everything is unapplied;
 *  - customer merge carries the open item over;
 *  - A/R and A/P control == aging == per-name balances after every step, CURRENT and AS OF earlier
 *    dates (historical aging must tie to the historical balance sheet too).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  billPayments,
  bills,
  invoices,
  journalEntryLines,
  journalItemApplications,
  paymentsReceived,
  users,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { createVendor } from './vendors';
import { apAging, apAgingDetail, arAging, arAgingDetail } from './reportsExtra';
import { vendorBalanceSummary } from './reportsLists';
import { trialBalance } from './reports';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { createBill, voidBill } from './bills';
import { createManualEntry, voidEntry } from './journal';
import { receivePayment, updatePayment, voidPayment } from './payments';
import { payBills, updateBillPayment, voidBillPayment } from './billPayments';
import {
  applyJournalCredit,
  listJournalApplications,
  listJournalOpenItems,
  unapplyJournalApplication,
} from './journalApplications';
import { mergeCustomers } from './merge';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-journal-applications-adv');

let db: DB;
let ctx: ServiceContext;
let ctxB: ServiceContext;
const code: Record<string, string> = {};
const codeB: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const EOD = (s: string) => new Date(`${s}T23:59:59Z`);
const NOW = new Date('2026-12-31T23:59:59Z');

async function controlOf(c: ServiceContext, subtype: 'accounts_receivable' | 'accounts_payable', asOf = NOW) {
  const tb = await trialBalance(c, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, c.companyId), sql`${accounts.subtype} = ${subtype}`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  return Math.round((subtype === 'accounts_receivable' ? total : -total) * 100) / 100;
}

async function expectTbBalanced(c: ServiceContext = ctx) {
  const tb = await trialBalance(c, NOW);
  expect(Number(tb.totalDebit)).toBeCloseTo(Number(tb.totalCredit), 2);
}

/** A/R control == aging == customer balances (total AND per customer). */
async function arTied(c: ServiceContext = ctx, expected?: number) {
  const control = await controlOf(c, 'accounts_receivable');
  const aging = await arAging(c, NOW);
  const balances = await customerBalanceSummary(c);
  expect(Number(aging.totals.total), 'A/R aging vs control').toBeCloseTo(control, 2);
  expect(balances.reduce((s, r) => s + Number(r.totalBalanceDue), 0), 'customer balances vs control').toBeCloseTo(control, 2);
  const agingBy = new Map(aging.rows.map((r) => [r.id, Number(r.total)]));
  for (const b of balances) expect(agingBy.get(b.customerId) ?? 0, `customer ${b.displayName}`).toBeCloseTo(Number(b.totalBalanceDue), 2);
  if (expected !== undefined) expect(control).toBeCloseTo(expected, 2);
  await expectTbBalanced(c);
  return control;
}

/** A/R control as of a past date == A/R aging as of that date. */
async function arTiedAsOf(asOf: Date, expected?: number) {
  const control = await controlOf(ctx, 'accounts_receivable', asOf);
  const aging = Number((await arAging(ctx, asOf)).totals.total);
  expect(aging, `A/R aging as of ${asOf.toISOString().slice(0, 10)} vs A/R control`).toBeCloseTo(control, 2);
  if (expected !== undefined) expect(control).toBeCloseTo(expected, 2);
}

/** A/P control == aging == vendor balance summary (total AND per vendor). */
async function apTied(c: ServiceContext = ctx, expected?: number) {
  const control = await controlOf(c, 'accounts_payable');
  const aging = await apAging(c, NOW);
  expect(Number(aging.totals.total), 'A/P aging vs control').toBeCloseTo(control, 2);
  const vbs = await vendorBalanceSummary(c, { asOf: '2026-12-31' } as never);
  const byVendor = new Map(
    vbs.rows.filter((r) => r.kind === 'data').map((r) => [String(r.id).slice('bal:'.length), Number(r.cells.balance)]),
  );
  for (const r of aging.rows) expect(byVendor.get(r.id) ?? 0, `vendor ${r.name}`).toBeCloseTo(Number(r.total), 2);
  if (expected !== undefined) expect(control).toBeCloseTo(expected, 2);
  await expectTbBalanced(c);
  return control;
}

async function apTiedAsOf(asOf: Date, expected?: number) {
  const control = await controlOf(ctx, 'accounts_payable', asOf);
  const aging = Number((await apAging(ctx, asOf)).totals.total);
  expect(aging, `A/P aging as of ${asOf.toISOString().slice(0, 10)} vs A/P control`).toBeCloseTo(control, 2);
  if (expected !== undefined) expect(control).toBeCloseTo(expected, 2);
}

async function lineOf(entryId: string, accountId: string) {
  const [l] = await db
    .select()
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, accountId)));
  return l;
}

async function arCharge(c: ServiceContext, codes: Record<string, string>, customerId: string, date: string, amount: string) {
  const je = await createManualEntry(c, {
    date: D(date),
    description: 'JE charge',
    lines: [
      { accountId: codes['1200'], debit: amount, entityType: 'customer', entityId: customerId },
      { accountId: codes['4000'], credit: amount },
    ],
  });
  return { entryId: je.id, lineId: (await lineOf(je.id, codes['1200'])).id };
}

async function arCredit(customerId: string, date: string, amount: string) {
  const je = await createManualEntry(ctx, {
    date: D(date),
    description: 'JE credit',
    lines: [
      { accountId: code['6000'], debit: amount },
      { accountId: code['1200'], credit: amount, entityType: 'customer', entityId: customerId },
    ],
  });
  return { entryId: je.id, lineId: (await lineOf(je.id, code['1200'])).id };
}

async function apOwed(vendorId: string, date: string, amount: string) {
  const je = await createManualEntry(ctx, {
    date: D(date),
    description: 'JE payable',
    lines: [
      { accountId: code['6000'], debit: amount },
      { accountId: code['2000'], credit: amount, entityType: 'vendor', entityId: vendorId },
    ],
  });
  return { entryId: je.id, lineId: (await lineOf(je.id, code['2000'])).id };
}

async function apVendorCredit(vendorId: string, date: string, amount: string) {
  const je = await createManualEntry(ctx, {
    date: D(date),
    description: 'JE vendor credit',
    lines: [
      { accountId: code['2000'], debit: amount, entityType: 'vendor', entityId: vendorId },
      { accountId: code['6000'], credit: amount },
    ],
  });
  return { entryId: je.id, lineId: (await lineOf(je.id, code['2000'])).id };
}

async function countRows() {
  const [p] = await db.select({ n: sql<number>`COUNT(*)` }).from(paymentsReceived).where(eq(paymentsReceived.companyId, ctx.companyId));
  const [bp] = await db.select({ n: sql<number>`COUNT(*)` }).from(billPayments).where(eq(billPayments.companyId, ctx.companyId));
  const [a] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(journalItemApplications)
    .where(eq(journalItemApplications.companyId, ctx.companyId));
  return { payments: Number(p.n), billPayments: Number(bp.n), applications: Number(a.n) };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'ledger-ja-adv@test.local', name: 'Ledger QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'JE Items QA Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
  const companyB = await createCompany(db, { name: 'Other Books Co', ownerId: user.id });
  ctxB = { db, companyId: companyB.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctxB.companyId))) codeB[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('A/R General Journal charges — adversarial', () => {
  it('penny-exact partial payments close the charge to zero; one more cent is refused', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Penny Customer' })).id;
    const { lineId } = await arCharge(ctx, code, cust, '2026-01-05', '100.01');
    const start = await arTied();
    for (const [i, amt] of ['33.33', '33.33', '33.35'].entries()) {
      await receivePayment(ctx, {
        customerId: cust,
        date: D(`2026-01-1${i}`),
        method: 'check',
        amount: amt,
        depositAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: lineId, amount: amt }],
      });
      await arTied();
    }
    expect((await listJournalOpenItems(ctx, 'ar', cust)).charges).toHaveLength(0);
    expect(await arTied()).toBeCloseTo(start - 100.01, 2);
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-01-20'),
        method: 'check',
        amount: '0.01',
        depositAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: lineId, amount: '0.01' }],
      }),
    ).rejects.toThrow(/left open/);
    await arTied();
  });

  it('the same line listed twice can not exceed what is open; nothing is written', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Twice Customer' })).id;
    const { lineId } = await arCharge(ctx, code, cust, '2026-01-06', '50.00');
    const before = await countRows();
    const ar = await arTied();
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-01-07'),
        method: 'check',
        amount: '60.00',
        depositAccountId: code['1000'],
        applications: [],
        journalItems: [
          { journalLineId: lineId, amount: '30.00' },
          { journalLineId: lineId, amount: '30.00' },
        ],
      }),
    ).rejects.toThrow(/left open/);
    expect(await countRows()).toEqual(before);
    expect(await arTied()).toBeCloseTo(ar, 2);
  });

  it('payment larger than the charge: the rest stays as unapplied credit, still tied', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Overpay Customer' })).id;
    const { lineId } = await arCharge(ctx, code, cust, '2026-01-08', '80.00');
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-01-09'),
      method: 'check',
      amount: '100.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: lineId, amount: '80.00' }],
    });
    expect(payment.unapplied).toBe('20.00');
    const bal = (await customerBalanceSummary(ctx)).find((r) => r.customerId === cust);
    expect(Number(bal?.totalBalanceDue ?? 0)).toBeCloseTo(-20, 2);
    await arTied();

    // Editing the payment to drop the journal item reopens the whole charge.
    await updatePayment(ctx, payment.id, {
      customerId: cust,
      date: D('2026-01-09'),
      method: 'check',
      amount: '100.00',
      depositAccountId: code['1000'],
      applications: [],
    });
    expect((await listJournalOpenItems(ctx, 'ar', cust)).charges[0].open).toBe('80.00');
    const [p] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, payment.id));
    expect(p.unapplied).toBe('100.00');
    await arTied();
  });

  it('rollback: a valid journal charge plus an invalid journal credit saves nothing', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Rollback Customer' })).id;
    const other = (await createCustomer(ctx, { displayName: 'Rollback Other' })).id;
    const { lineId } = await arCharge(ctx, code, cust, '2026-01-10', '40.00');
    const credit = await arCredit(cust, '2026-01-10', '15.00');
    const otherInv = await createInvoice(ctx, {
      customerId: other,
      date: D('2026-01-10'),
      lines: [{ description: 'Not yours', quantity: 1, rate: '50.00' }],
    });
    const before = await countRows();
    const ar = await arTied();
    await expect(
      receivePayment(ctx, {
        customerId: cust,
        date: D('2026-01-11'),
        method: 'check',
        amount: '40.00',
        depositAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: lineId, amount: '40.00' }],
        journalCredits: [{ journalLineId: credit.lineId, invoiceId: otherInv.id, amount: '15.00' }],
      }),
    ).rejects.toThrow();
    expect(await countRows()).toEqual(before);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, otherInv.id));
    expect(inv.balanceDue).toBe('50.00');
    const open = await listJournalOpenItems(ctx, 'ar', cust);
    expect(open.charges[0].open).toBe('40.00');
    expect(open.credits[0].open).toBe('15.00');
    expect(await arTied()).toBeCloseTo(ar, 2);
  });

  it('only named General Journal A/R lines qualify (document postings and A/P lines are refused)', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Strict Customer' })).id;
    const vend = (await createVendor(ctx, { displayName: 'Strict Vendor' })).id;
    // An A/R line without a name can't even be saved (so it can never be an open item).
    await expect(
      createManualEntry(ctx, {
        date: D('2026-01-12'),
        description: 'No name',
        lines: [
          { accountId: code['1200'], debit: '10.00' },
          { accountId: code['4000'], credit: '10.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: D('2026-01-12'),
      lines: [{ description: 'Doc', quantity: 1, rate: '25.00' }],
    });
    const [invRow] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    const owed = await apOwed(vend, '2026-01-12', '30.00');
    const base = {
      customerId: cust,
      date: D('2026-01-13'),
      method: 'check' as const,
      amount: '10.00',
      depositAccountId: code['1000'],
      applications: [],
    };
    for (const lineId of [
      (await lineOf(invRow.postedEntryId!, code['1200'])).id,
      owed.lineId,
    ]) {
      await expect(receivePayment(ctx, { ...base, journalItems: [{ journalLineId: lineId, amount: '10.00' }] })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    }
    // A/R side lines can't be paid in Pay Bills either.
    const charge = await arCharge(ctx, code, cust, '2026-01-12', '10.00');
    await expect(
      payBills(ctx, {
        vendorId: vend,
        date: D('2026-01-13'),
        method: 'check',
        paymentAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: charge.lineId, amount: '10.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await arTied();
    await apTied();
  });

  it('an invoice carrying a General Journal credit can not be voided or shrunk below it', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Guarded Invoice Customer' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: D('2026-01-14'),
      lines: [{ description: 'Job', quantity: 1, rate: '100.00', accountId: code['4000'] }],
    });
    const credit = await arCredit(cust, '2026-01-14', '60.00');
    await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '60.00', date: D('2026-01-15') });
    await arTied();
    await expect(voidInvoice(ctx, inv.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      updateInvoice(ctx, inv.id, {
        customerId: cust,
        date: D('2026-01-14'),
        lines: [{ description: 'Job', quantity: 1, rate: '50.00', accountId: code['4000'] }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await arTied();
  });

  it('unapplying an application dated in a closed period is refused; after unapplying, the entry can be voided', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'Closed Unapply Customer' })).id;
    const { entryId, lineId } = await arCharge(ctx, code, cust, '2026-02-01', '90.00');
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-02-02'),
      method: 'check',
      amount: '90.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: lineId, amount: '90.00' }],
    });
    const [app] = await listJournalApplications(ctx, { paymentId: payment.id });
    await setClosingDate(ctx, { closingDate: '2026-02-28', password: 'pw' });
    try {
      await expect(unapplyJournalApplication(ctx, app.id)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      expect((await listJournalApplications(ctx, { paymentId: payment.id })).length).toBe(1);
    } finally {
      await setClosingDate(ctx, { closingDate: null, password: null });
    }
    await expect(voidEntry(ctx, entryId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await unapplyJournalApplication(ctx, app.id);
    await arTied();
    await voidEntry(ctx, entryId);
    expect((await listJournalOpenItems(ctx, 'ar', cust)).charges).toHaveLength(0);
    await arTied();
  });

  it('merging customers carries the open General Journal charge to the surviving customer', async () => {
    const from = (await createCustomer(ctx, { displayName: 'Merge From' })).id;
    const to = (await createCustomer(ctx, { displayName: 'Merge To' })).id;
    const { lineId } = await arCharge(ctx, code, from, '2026-02-05', '70.00');
    await receivePayment(ctx, {
      customerId: from,
      date: D('2026-02-06'),
      method: 'check',
      amount: '20.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: lineId, amount: '20.00' }],
    });
    await mergeCustomers(ctx, { fromId: from, toId: to });
    const open = await listJournalOpenItems(ctx, 'ar', to);
    expect(open.charges.map((c) => c.open)).toEqual(['50.00']);
    await receivePayment(ctx, {
      customerId: to,
      date: D('2026-02-07'),
      method: 'check',
      amount: '50.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: lineId, amount: '50.00' }],
    });
    expect((await listJournalOpenItems(ctx, 'ar', to)).charges).toHaveLength(0);
    await arTied();
  });
});

describe('multi-company isolation', () => {
  it("company B can't list, pay or apply company A's General Journal lines", async () => {
    const custA = (await createCustomer(ctx, { displayName: 'Isolated A' })).id;
    const { lineId } = await arCharge(ctx, code, custA, '2026-02-10', '33.00');
    const custB = (await createCustomer(ctxB, { displayName: 'Isolated B' })).id;
    const invB = await createInvoice(ctxB, {
      customerId: custB,
      date: D('2026-02-10'),
      lines: [{ description: 'B job', quantity: 1, rate: '33.00' }],
    });
    expect(await listJournalOpenItems(ctxB, 'ar', custA)).toEqual({ charges: [], credits: [] });
    await expect(
      receivePayment(ctxB, {
        customerId: custB,
        date: D('2026-02-11'),
        method: 'check',
        amount: '33.00',
        depositAccountId: codeB['1000'],
        applications: [],
        journalItems: [{ journalLineId: lineId, amount: '33.00' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      applyJournalCredit(ctxB, { journalLineId: lineId, invoiceId: invB.id, amount: '1.00' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A's own line, B's invoice (wrong company) from A's context.
    const credit = await arCredit(custA, '2026-02-10', '5.00');
    await expect(
      applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: invB.id, amount: '5.00' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listJournalOpenItems(ctx, 'ar', custA)).charges[0].open).toBe('33.00');
    await arTied();
    await arTied(ctxB, 33);
  });
});

describe('A/P General Journal items — adversarial', () => {
  it('rollback: bill payment + journal credit that would take the bill past zero saves nothing', async () => {
    const vend = (await createVendor(ctx, { displayName: 'Rollback Vendor' })).id;
    const bill = await createBill(ctx, { vendorId: vend, date: D('2026-03-01'), billNumber: 'RB-1', lines: [{ accountId: code['6000'], amount: '400.00' }] });
    const owed = await apOwed(vend, '2026-03-01', '100.00');
    const vc = await apVendorCredit(vend, '2026-03-01', '150.00');
    const before = await countRows();
    const ap = await apTied();
    await expect(
      payBills(ctx, {
        vendorId: vend,
        date: D('2026-03-02'),
        method: 'check',
        paymentAccountId: code['1000'],
        applications: [{ billId: bill.id, amountApplied: '300.00' }],
        journalItems: [{ journalLineId: owed.lineId, amount: '100.00' }],
        journalCredits: [{ journalLineId: vc.lineId, billId: bill.id, amount: '150.00' }],
      }),
    ).rejects.toThrow();
    expect(await countRows()).toEqual(before);
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b.balanceDue).toBe('400.00');
    expect(b.amountPaid ?? '0.00').toBe('0.00');
    const open = await listJournalOpenItems(ctx, 'ap', vend);
    expect(open.charges[0].open).toBe('100.00');
    expect(open.credits[0].open).toBe('150.00');
    expect(await apTied()).toBeCloseTo(ap, 2);
  });

  it('exact fit: bill paid 250 cash + 150 journal credit, JE payable paid in pennies; then the bill is guarded', async () => {
    const vend = (await createVendor(ctx, { displayName: 'Exact Vendor' })).id;
    const bill = await createBill(ctx, { vendorId: vend, date: D('2026-03-03'), billNumber: 'EX-1', lines: [{ accountId: code['6000'], amount: '400.00' }] });
    const owed = await apOwed(vend, '2026-03-03', '0.03');
    const vc = await apVendorCredit(vend, '2026-03-03', '150.00');
    await payBills(ctx, {
      vendorId: vend,
      date: D('2026-03-04'),
      method: 'check',
      paymentAccountId: code['1000'],
      applications: [{ billId: bill.id, amountApplied: '250.00' }],
      journalItems: [{ journalLineId: owed.lineId, amount: '0.01' }],
      journalCredits: [{ journalLineId: vc.lineId, billId: bill.id, amount: '150.00' }],
    });
    for (const d of ['2026-03-05', '2026-03-06']) {
      await payBills(ctx, {
        vendorId: vend,
        date: D(d),
        method: 'check',
        paymentAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: owed.lineId, amount: '0.01' }],
      });
      await apTied();
    }
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b.status).toBe('paid');
    expect(b.balanceDue).toBe('0.00');
    expect(await listJournalOpenItems(ctx, 'ap', vend)).toEqual({ charges: [], credits: [] });
    await expect(voidBill(ctx, bill.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(voidEntry(ctx, vc.entryId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await apTied();
  });

  it('a JE vendor credit can be applied to a bill alone (no cash), then unapplied', async () => {
    const vend = (await createVendor(ctx, { displayName: 'Credit Only Vendor' })).id;
    const bill = await createBill(ctx, { vendorId: vend, date: D('2026-03-07'), billNumber: 'CO-1', lines: [{ accountId: code['6000'], amount: '75.00' }] });
    const vc = await apVendorCredit(vend, '2026-03-07', '75.00');
    const app = await applyJournalCredit(ctx, { journalLineId: vc.lineId, billId: bill.id, amount: '75.00', date: D('2026-03-08') });
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b.status).toBe('paid');
    await apTied();
    // Wrong vendor's bill is refused.
    const other = (await createVendor(ctx, { displayName: 'Credit Only Other' })).id;
    const otherBill = await createBill(ctx, { vendorId: other, date: D('2026-03-07'), billNumber: 'CO-2', lines: [{ accountId: code['6000'], amount: '10.00' }] });
    await unapplyJournalApplication(ctx, app.id);
    await expect(
      applyJournalCredit(ctx, { journalLineId: vc.lineId, billId: otherBill.id, amount: '10.00' }),
    ).rejects.toThrow(/different vendor/);
    await apTied();
  });
});

describe('historical (as-of) aging ties to the balance sheet', () => {
  it('A/R: a General Journal credit applied to an earlier invoice — aging as of BEFORE the credit equals A/R control', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'As-Of Customer' })).id;
    const before = await controlOf(ctx, 'accounts_receivable', EOD('2026-04-03'));
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: D('2026-04-01'),
      lines: [{ description: 'April work', quantity: 1, rate: '300.00' }],
    });
    const credit = await arCredit(cust, '2026-04-05', '100.00');
    await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '100.00', date: D('2026-04-10') });
    // As of Apr 3 the customer owed the full 300 (the credit did not exist yet).
    await arTiedAsOf(EOD('2026-04-03'), before + 300);
    await arTiedAsOf(EOD('2026-04-07'));
    await arTiedAsOf(EOD('2026-04-12'));
    await arTied();
  });

  it('A/R: a General Journal charge paid later — aging between the two dates shows the full charge', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'As-Of Charge Customer' })).id;
    const { lineId } = await arCharge(ctx, code, cust, '2026-04-15', '55.00');
    await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-04-20'),
      method: 'check',
      amount: '55.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: lineId, amount: '55.00' }],
    });
    await arTiedAsOf(EOD('2026-04-17'));
    await arTiedAsOf(EOD('2026-04-21'));
  });

  it('A/P: a General Journal vendor credit applied to an earlier bill — aging as of BEFORE the credit equals A/P control', async () => {
    const vend = (await createVendor(ctx, { displayName: 'As-Of Vendor' })).id;
    const before = await controlOf(ctx, 'accounts_payable', EOD('2026-05-03'));
    const bill = await createBill(ctx, { vendorId: vend, date: D('2026-05-01'), billNumber: 'AO-1', lines: [{ accountId: code['6000'], amount: '200.00' }] });
    const vc = await apVendorCredit(vend, '2026-05-05', '80.00');
    await applyJournalCredit(ctx, { journalLineId: vc.lineId, billId: bill.id, amount: '80.00', date: D('2026-05-10') });
    await apTiedAsOf(EOD('2026-05-03'), before + 200);
    await apTiedAsOf(EOD('2026-05-07'));
    await apTiedAsOf(EOD('2026-05-12'));
    await apTied();
  });

  it('A/P: a General Journal amount owed paid later — aging between the two dates shows it', async () => {
    const vend = (await createVendor(ctx, { displayName: 'As-Of Owed Vendor' })).id;
    const owed = await apOwed(vend, '2026-05-15', '66.00');
    await payBills(ctx, {
      vendorId: vend,
      date: D('2026-05-20'),
      method: 'check',
      paymentAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: owed.lineId, amount: '66.00' }],
    });
    await apTiedAsOf(EOD('2026-05-17'));
    await apTiedAsOf(EOD('2026-05-21'));
    await apTied();
  });
});

// ---------------------------------------------------------------------------
// Re-test round 1: dated General Journal applications (as-of aging) — attacks on the fix
// ---------------------------------------------------------------------------

/** A/R control == aging == aging detail, as of `d` (end of day). */
async function arAllTiedOn(d: string) {
  const asOf = EOD(d);
  const control = await controlOf(ctx, 'accounts_receivable', asOf);
  const aging = Number((await arAging(ctx, asOf)).totals.total);
  const detail = (await arAgingDetail(ctx, asOf)).rows.reduce((s, r) => s + Number(r.openBalance), 0);
  expect(aging, `A/R aging on ${d} vs control`).toBeCloseTo(control, 2);
  expect(detail, `A/R aging detail on ${d} vs control`).toBeCloseTo(control, 2);
}
async function apAllTiedOn(d: string) {
  const asOf = EOD(d);
  const control = await controlOf(ctx, 'accounts_payable', asOf);
  const aging = Number((await apAging(ctx, asOf)).totals.total);
  const detail = (await apAgingDetail(ctx, asOf)).rows.reduce((s, r) => s + Number(r.openBalance), 0);
  expect(aging, `A/P aging on ${d} vs control`).toBeCloseTo(control, 2);
  expect(detail, `A/P aging detail on ${d} vs control`).toBeCloseTo(control, 2);
}

describe('round 2: as-of aging with dated General Journal applications', () => {
  it('A/R: credit applied inside Receive Payments (with cash), then the payment is re-dated and voided — ties every day', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R2 Payment Credit Customer' })).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: D('2026-09-01'),
      lines: [{ description: 'Sept work', quantity: 1, rate: '300.00' }],
    });
    const credit = await arCredit(cust, '2026-09-05', '100.00');
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-09-10'),
      method: 'check',
      amount: '50.00',
      depositAccountId: code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '50.00' }],
      journalCredits: [{ journalLineId: credit.lineId, invoiceId: inv.id, amount: '100.00' }],
    });
    for (const d of ['2026-09-03', '2026-09-07', '2026-09-11']) await arAllTiedOn(d);
    await arTied();
    // Re-date the payment two days later: the credit moves with it.
    await updatePayment(ctx, payment.id, {
      customerId: cust,
      date: D('2026-09-12'),
      method: 'check',
      amount: '50.00',
      depositAccountId: code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '50.00' }],
      journalCredits: [{ journalLineId: credit.lineId, invoiceId: inv.id, amount: '100.00' }],
    });
    const apps = await listJournalApplications(ctx, { journalEntryId: credit.entryId });
    expect(apps).toHaveLength(1);
    expect(new Date(apps[0].date).toISOString().slice(0, 10)).toBe('2026-09-12');
    for (const d of ['2026-09-07', '2026-09-11', '2026-09-13']) await arAllTiedOn(d);
    await voidPayment(ctx, apps[0].paymentId!);
    expect((await listJournalOpenItems(ctx, 'ar', cust)).credits.map((c) => c.open)).toEqual(['100.00']);
    for (const d of ['2026-09-07', '2026-09-11', '2026-09-13']) await arAllTiedOn(d);
    await arTied();
  });

  it('A/R: one General Journal credit split over two invoices on two dates — ties between and after', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R2 Split Credit Customer' })).id;
    const inv1 = await createInvoice(ctx, { customerId: cust, date: D('2026-09-14'), lines: [{ description: 'A', quantity: 1, rate: '40.01' }] });
    const inv2 = await createInvoice(ctx, { customerId: cust, date: D('2026-09-14'), lines: [{ description: 'B', quantity: 1, rate: '59.99' }] });
    const credit = await arCredit(cust, '2026-09-14', '100.00');
    await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv1.id, amount: '40.01', date: D('2026-09-16') });
    await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv2.id, amount: '59.98', date: D('2026-09-20') });
    for (const d of ['2026-09-15', '2026-09-17', '2026-09-21']) await arAllTiedOn(d);
    const [i2] = await db.select().from(invoices).where(eq(invoices.id, inv2.id));
    expect(i2.balanceDue).toBe('0.01');
    expect((await listJournalOpenItems(ctx, 'ar', cust)).credits.map((c) => c.open)).toEqual(['0.01']);
    await arTied();
  });

  it('A/R: moving the invoice date past the day a General Journal credit was applied keeps as-of aging tied (or is refused)', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R2 Moved Invoice Customer' })).id;
    const lines = [{ description: 'Moved', quantity: 1, rate: '120.00', accountId: code['4000'] }];
    const inv = await createInvoice(ctx, { customerId: cust, date: D('2026-09-22'), lines });
    const credit = await arCredit(cust, '2026-09-22', '20.00');
    await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '20.00', date: D('2026-09-23') });
    // Edit: invoice now dated Sep 28, after the application (Sep 23). Either the edit is refused,
    // or aging on Sep 25 must still equal A/R control on Sep 25.
    await updateInvoice(ctx, inv.id, { customerId: cust, date: D('2026-09-28'), lines }).catch(() => undefined);
    for (const d of ['2026-09-22', '2026-09-25', '2026-09-29']) await arAllTiedOn(d);
    await arTied();
  });

  it('A/R: re-dating a payment to before the General Journal charge it pays is refused and changes nothing', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R2 Early Redate Customer' })).id;
    const { lineId } = await arCharge(ctx, code, cust, '2026-10-05', '45.00');
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: D('2026-10-06'),
      method: 'check',
      amount: '45.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: lineId, amount: '45.00' }],
    });
    const before = await countRows();
    await expect(
      updatePayment(ctx, payment.id, {
        customerId: cust,
        date: D('2026-10-01'),
        method: 'check',
        amount: '45.00',
        depositAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: lineId, amount: '45.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countRows()).toEqual(before);
    const [p] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, payment.id));
    expect(p.voidedAt).toBeNull();
    expect(new Date(p.date).toISOString().slice(0, 10)).toBe('2026-10-06');
    expect((await listJournalOpenItems(ctx, 'ar', cust)).charges).toHaveLength(0);
    for (const d of ['2026-10-05', '2026-10-07']) await arAllTiedOn(d);
    await arTied();
  });

  it('A/P: vendor credit applied inside Pay Bills, payment re-dated then voided — ties every day', async () => {
    const vend = (await createVendor(ctx, { displayName: 'R2 Pay Bills Vendor' })).id;
    const bill = await createBill(ctx, { vendorId: vend, date: D('2026-09-01'), billNumber: 'R2-1', lines: [{ accountId: code['6000'], amount: '200.00' }] });
    const vc = await apVendorCredit(vend, '2026-09-05', '80.00');
    await payBills(ctx, {
      vendorId: vend,
      date: D('2026-09-10'),
      method: 'check',
      paymentAccountId: code['1000'],
      applications: [{ billId: bill.id, amountApplied: '20.00' }],
      journalCredits: [{ journalLineId: vc.lineId, billId: bill.id, amount: '80.00' }],
    });
    const [first] = await listJournalApplications(ctx, { journalEntryId: vc.entryId });
    expect(first?.billPaymentId).toBeTruthy();
    expect(new Date(first.date).toISOString().slice(0, 10)).toBe('2026-09-10');
    for (const d of ['2026-09-03', '2026-09-07', '2026-09-11']) await apAllTiedOn(d);
    await apTied();
    await updateBillPayment(ctx, first.billPaymentId!, {
      vendorId: vend,
      date: D('2026-09-12'),
      method: 'check',
      paymentAccountId: code['1000'],
      applications: [{ billId: bill.id, amountApplied: '20.00' }],
      journalCredits: [{ journalLineId: vc.lineId, billId: bill.id, amount: '80.00' }],
    });
    for (const d of ['2026-09-07', '2026-09-11', '2026-09-13']) await apAllTiedOn(d);
    await apTied();
    const [app] = await listJournalApplications(ctx, { journalEntryId: vc.entryId });
    expect(new Date(app.date).toISOString().slice(0, 10)).toBe('2026-09-12');
    await voidBillPayment(ctx, app.billPaymentId!);
    expect((await listJournalOpenItems(ctx, 'ap', vend)).credits.map((c) => c.open)).toEqual(['80.00']);
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b.balanceDue).toBe('200.00');
    for (const d of ['2026-09-07', '2026-09-11', '2026-09-13']) await apAllTiedOn(d);
    await apTied();
  });

  it('A/P: paying a General Journal amount owed with a bill payment dated before it is refused', async () => {
    const vend = (await createVendor(ctx, { displayName: 'R2 Early Bill Payment Vendor' })).id;
    const owed = await apOwed(vend, '2026-10-10', '33.00');
    const before = await countRows();
    await expect(
      payBills(ctx, {
        vendorId: vend,
        date: D('2026-10-08'),
        method: 'check',
        paymentAccountId: code['1000'],
        applications: [],
        journalItems: [{ journalLineId: owed.lineId, amount: '33.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await countRows()).toEqual(before);
    for (const d of ['2026-10-09', '2026-10-11']) await apAllTiedOn(d);
    await apTied();
  });

  it('closing date: a credit applied after the close to an invoice inside the closed period leaves the closed period tied', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R2 Closed Period Customer' })).id;
    const inv = await createInvoice(ctx, { customerId: cust, date: D('2026-07-10'), lines: [{ description: 'July', quantity: 1, rate: '75.00' }] });
    const credit = await arCredit(cust, '2026-07-12', '25.00');
    await setClosingDate(ctx, { closingDate: '2026-07-31', password: 'pw' });
    try {
      await expect(
        applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '25.00', date: D('2026-07-20') }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      const app = await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '25.00', date: D('2026-08-03') });
      expect(new Date(app.date).toISOString().slice(0, 10)).toBe('2026-08-03');
      await arAllTiedOn('2026-07-31');
      await arAllTiedOn('2026-08-04');
    } finally {
      await setClosingDate(ctx, { closingDate: null, password: null });
    }
    await arTied();
  });
});

// ---------------------------------------------------------------------------
// Re-test round 2: attacks on the GREATEST(application, invoice / bill date) fix
// ---------------------------------------------------------------------------

describe('round 3: re-dated documents carrying General Journal credits', () => {
  it('A/P mirror: re-dating a bill past the day a General Journal vendor credit was applied keeps as-of aging tied (or is refused)', async () => {
    const vend = (await createVendor(ctx, { displayName: 'R3 Moved Bill Vendor' })).id;
    const billIn = (date: string) => ({ vendorId: vend, date: D(date), billNumber: 'R3-MV', lines: [{ accountId: code['6000'], amount: '120.00' }] });
    const bill = await createBill(ctx, billIn('2026-09-22'));
    const vc = await apVendorCredit(vend, '2026-09-22', '20.00');
    await applyJournalCredit(ctx, { journalLineId: vc.lineId, billId: bill.id, amount: '20.00', date: D('2026-09-23') });
    const { updateBill } = await import('./bills');
    await updateBill(ctx, bill.id, billIn('2026-09-28')).catch(() => undefined);
    for (const d of ['2026-09-22', '2026-09-23', '2026-09-25', '2026-09-28', '2026-09-29']) await apAllTiedOn(d);
    await apTied();
  });

  it('A/R: changing the customer on an invoice carrying a General Journal credit is refused; per-customer balances stay tied', async () => {
    const a = (await createCustomer(ctx, { displayName: 'R3 Swap A' })).id;
    const b = (await createCustomer(ctx, { displayName: 'R3 Swap B' })).id;
    const lines = [{ description: 'Swap', quantity: 1, rate: '50.00', accountId: code['4000'] }];
    const inv = await createInvoice(ctx, { customerId: a, date: D('2026-10-01'), lines });
    const credit = await arCredit(a, '2026-10-01', '30.00');
    await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '30.00', date: D('2026-10-02') });
    await expect(updateInvoice(ctx, inv.id, { customerId: b, date: D('2026-10-01'), lines })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.customerId).toBe(a);
    await arTied();
  });

  it('A/R: invoice moved later, then the credit is unapplied and re-applied — the new application is not dated before the invoice', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R3 Reapply Customer' })).id;
    const lines = [{ description: 'Penny', quantity: 1, rate: '100.01', accountId: code['4000'] }];
    const inv = await createInvoice(ctx, { customerId: cust, date: D('2026-10-10'), lines });
    const credit = await arCredit(cust, '2026-10-10', '33.33');
    const app = await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '33.33', date: D('2026-10-11') });
    const moved = await updateInvoice(ctx, inv.id, { customerId: cust, date: D('2026-10-15'), lines }).then(
      () => true,
      () => false,
    );
    for (const d of ['2026-10-10', '2026-10-12', '2026-10-15', '2026-10-16']) await arAllTiedOn(d);
    await unapplyJournalApplication(ctx, app.id);
    for (const d of ['2026-10-12', '2026-10-16']) await arAllTiedOn(d);
    const again = await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '33.33', date: D('2026-10-12') });
    expect(new Date(again.date).toISOString().slice(0, 10)).toBe(moved ? '2026-10-15' : '2026-10-12');
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.balanceDue).toBe('66.68');
    for (const d of ['2026-10-11', '2026-10-13', '2026-10-15', '2026-10-16']) await arAllTiedOn(d);
    await arTied();
  });

  it('A/R: invoice moved EARLIER than the General Journal credit entry — ties before, between and after', async () => {
    const cust = (await createCustomer(ctx, { displayName: 'R3 Earlier Customer' })).id;
    const lines = [{ description: 'Earlier', quantity: 1, rate: '90.00', accountId: code['4000'] }];
    const inv = await createInvoice(ctx, { customerId: cust, date: D('2026-11-10'), lines });
    const credit = await arCredit(cust, '2026-11-10', '40.00');
    await applyJournalCredit(ctx, { journalLineId: credit.lineId, invoiceId: inv.id, amount: '40.00', date: D('2026-11-11') });
    await updateInvoice(ctx, inv.id, { customerId: cust, date: D('2026-11-02'), lines }).catch(() => undefined);
    for (const d of ['2026-11-01', '2026-11-03', '2026-11-10', '2026-11-11', '2026-11-12']) await arAllTiedOn(d);
    await arTied();
  });
});
