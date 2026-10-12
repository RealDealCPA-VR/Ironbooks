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
import { apAging, arAging } from './reportsExtra';
import { vendorBalanceSummary } from './reportsLists';
import { trialBalance } from './reports';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { createBill, voidBill } from './bills';
import { createManualEntry, voidEntry } from './journal';
import { receivePayment, updatePayment } from './payments';
import { payBills } from './billPayments';
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
