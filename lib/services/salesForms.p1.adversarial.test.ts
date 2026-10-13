/**
 * p1/salesforms — independent adversarial QA (tester).
 *
 * Probes every team item against QuickBooks Desktop behaviour and the ledger invariants
 * (TB balanced, A/R control == aging == customer balances, integrity checks):
 *  1. typed document numbers (create/edit duplicates, multi-company isolation, posted+paid edits,
 *     closing date + rollback, trimming);
 *  2. customer default tax item / non-taxable tax code (all five forms, edits, conversions,
 *     statement charges, rounding);
 *  3. retainage (penny rounding, partial payments, closing date, isolation, tax, FX, API);
 *  4. ship-to (defaults, conversions, customer edits, packing slip wiring, upgraded-db migration);
 *  5. open-item statements (as-of credits applied later, retainage, voids, GL tie, isolation).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers,
  vendors,
  taxRates,
  taxAgencies,
  invoices,
  journalEntries,
  journalEntryLines,
  accounts,
  auditLogs,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice, updateInvoice, getInvoice, voidInvoice } from './invoices';
import { createEstimate, updateEstimate, convertToInvoice as convertEstimate } from './estimates';
import { createSalesOrder, updateSalesOrder, convertToInvoice as convertSalesOrder } from './salesOrders';
import { createSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createCreditMemo, updateCreditMemo, applyToInvoice } from './creditMemos';
import { createPurchaseOrder } from './purchaseOrders';
import { createStatementCharge } from './batchInvoicing';
import { nextDocNumber } from './docNumbers';
import { createCustomer, updateCustomer } from './customers';
import { receivePayment } from './payments';
import { createManualEntry } from './journal';
import { billRetainage, retainageReport } from './retainage';
import { customerArLedgerBalance, openItemStatement } from './statements';
import { arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { verifyIntegrity } from './integrity';

// Route handlers under test use the mocked server context; the packing-slip renderer is
// mocked so we can see exactly what the route hands it.
vi.mock('@/lib/context', () => ({
  getServerContext: vi.fn(async () => ctx),
}));
const slipCalls: Array<Record<string, unknown>> = [];
vi.mock('@/lib/pdf/packingSlip', () => ({
  renderPackingSlipPdf: vi.fn(async (args: Record<string, unknown>) => {
    slipCalls.push(args);
    return new Uint8Array([37, 80, 68, 70]);
  }),
}));
import { GET as retainageGET, POST as retainagePOST } from '@/app/api/invoices/retainage/route';
import { GET as packingSlipGET } from '@/app/api/invoices/[id]/packing-slip/route';
import { PATCH as invoicePATCH } from '@/app/api/invoices/[id]/route';
import { POST as invoicesPOST } from '@/app/api/invoices/route';
import { NextRequest } from 'next/server';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-salesforms-adv');
let db: DB;
let ctx: ServiceContext; // company A
let ctxB: ServiceContext; // company B (isolation)
const acct: Record<string, string> = {};
const acctB: Record<string, string> = {};
let rate10: string;
let rate825: string;
let taxCust: string;
let nonCust: string;
let plainCust: string;
let vendorId: string;

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const L = (rate: number | string = 100, extra: Record<string, unknown> = {}) => ({
  description: 'Work',
  quantity: 1,
  rate,
  accountId: acct['4000'],
  ...extra,
});

const ACCOUNTS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
  ['3000', "Owner's Equity", 'equity', 'owners_equity'],
  ['4000', 'Sales Income', 'revenue', 'sales'],
  ['6000', 'Supplies', 'expense', 'operating_expenses'],
];

async function newCompany(name: string, email: string, into: Record<string, string>) {
  const [u] = await db.insert(users).values({ email, name, passwordHash: 'x' }).returning();
  const [c] = await db.insert(companies).values({ name, ownerId: u.id }).returning();
  const c2: ServiceContext = { db, companyId: c.id, userId: u.id };
  for (const [code, n, type, subtype] of ACCOUNTS) {
    into[code] = (await createAccount(c2, { code, name: n, type: type as never, subtype })).id;
  }
  return c2;
}

async function setClosing(c: ServiceContext, date: string | null) {
  await db
    .update(companies)
    .set({ settings: (date ? { closingDate: date } : {}) as never })
    .where(eq(companies.id, c.companyId));
}

/** Sum of open balances of a customer's posted invoices, in home currency. */
async function openInvoices(c: ServiceContext, customerId: string) {
  const rows = await db
    .select({ b: invoices.balanceDue, r: invoices.exchangeRate, s: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.companyId, c.companyId), eq(invoices.customerId, customerId)));
  return rows
    .filter((x) => x.s !== 'void' && x.s !== 'draft')
    .reduce((s, x) => s.plus(Money.round2(Money.mul(x.b, x.r ?? '1'))), Money.zero())
    .toFixed(2);
}

async function assertBooks(c: ServiceContext) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  const integ = await verifyIntegrity(c);
  const bad = integ.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`);
  expect(bad).toEqual([]);
}

async function accountBalance(c: ServiceContext, code: string) {
  const [row] = await db
    .select({
      net: sql<string>`COALESCE(SUM(CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC) - CAST(COALESCE(${journalEntryLines.credit}, '0') AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .where(and(eq(journalEntries.companyId, c.companyId), eq(journalEntries.status, 'posted'), eq(accounts.code, code)));
  return Money.of(row?.net ?? '0').toFixed(2);
}

describe('p1/salesforms adversarial QA', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    ctx = await newCompany('Adv SF Co', 'advsf@t.local', acct);
    ctxB = await newCompany('Adv SF Other Co', 'advsfb@t.local', acctB);
    const [agency] = await db
      .insert(taxAgencies)
      .values({ companyId: ctx.companyId, name: 'State', liabilityAccountId: acct['2200'] })
      .returning();
    rate10 = (await db.insert(taxRates).values({ companyId: ctx.companyId, name: 'Tax 10%', rate: '0.100000', agencyId: agency.id }).returning())[0].id;
    rate825 = (await db.insert(taxRates).values({ companyId: ctx.companyId, name: 'Tax 8.25%', rate: '0.082500', agencyId: agency.id }).returning())[0].id;
    taxCust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Taxed', taxRateId: rate10 }).returning())[0].id;
    nonCust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Exempt', taxable: false, taxRateId: rate10 }).returning())[0].id;
    plainCust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Plain' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Supplier' }).returning())[0].id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // =================================================================== 1. typed numbers
  describe('typed document numbers', () => {
    it('every create path refuses a duplicate typed number until the user confirms (case-insensitive)', async () => {
      const dup = { code: 'CONFLICT', details: { duplicateDocNumber: true } };
      await createEstimate(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'E-DUP', lines: [{ description: 'q', quantity: 1, rate: 1 }] });
      await expect(createEstimate(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'e-dup', lines: [{ description: 'q', quantity: 1, rate: 1 }] })).rejects.toMatchObject(dup);
      expect((await createEstimate(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'E-DUP', allowDuplicateNumber: true, lines: [{ description: 'q', quantity: 1, rate: 1 }] })).refNumber).toBe('E-DUP');

      await createSalesOrder(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'SO-DUP', lines: [{ description: 'x', quantity: 1, rate: 1 }] });
      await expect(createSalesOrder(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'SO-DUP', lines: [{ description: 'x', quantity: 1, rate: 1 }] })).rejects.toMatchObject(dup);

      await createSalesReceipt(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'SR-DUP', lines: [L(5)] });
      await expect(createSalesReceipt(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'SR-DUP', lines: [L(5)] })).rejects.toMatchObject(dup);

      await createCreditMemo(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'CM-DUP', lines: [L(5)] });
      await expect(createCreditMemo(ctx, { customerId: plainCust, date: D('2026-02-01'), refNumber: 'CM-DUP', lines: [L(5)] })).rejects.toMatchObject(dup);

      await createPurchaseOrder(ctx, { vendorId, date: D('2026-02-01'), refNumber: 'PO-DUP', lines: [{ accountId: acct['6000'], quantity: 1, rate: 5 }] });
      await expect(createPurchaseOrder(ctx, { vendorId, date: D('2026-02-01'), refNumber: 'PO-DUP', lines: [{ accountId: acct['6000'], quantity: 1, rate: 5 }] })).rejects.toMatchObject(dup);
      await assertBooks(ctx);
    });

    it('edits of estimate / sales receipt / credit memo to another doc number need confirmation', async () => {
      const e = await createEstimate(ctx, { customerId: plainCust, date: D('2026-02-02'), refNumber: 'E-OTHER', lines: [{ description: 'q', quantity: 1, rate: 1 }] });
      await expect(updateEstimate(ctx, e.id, { customerId: plainCust, date: D('2026-02-02'), refNumber: 'E-DUP', lines: [{ description: 'q', quantity: 1, rate: 1 }] })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await updateEstimate(ctx, e.id, { customerId: plainCust, date: D('2026-02-02'), refNumber: 'E-DUP', allowDuplicateNumber: true, lines: [{ description: 'q', quantity: 1, rate: 1 }] })).refNumber).toBe('E-DUP');

      const sr = await createSalesReceipt(ctx, { customerId: plainCust, date: D('2026-02-02'), refNumber: 'SR-OTHER', lines: [L(5)] });
      await expect(updateSalesReceipt(ctx, sr.id, { customerId: plainCust, date: D('2026-02-02'), refNumber: 'sr-dup', lines: [L(5)] })).rejects.toMatchObject({ code: 'CONFLICT' });
      const cm = await createCreditMemo(ctx, { customerId: plainCust, date: D('2026-02-02'), refNumber: 'CM-OTHER', lines: [L(5)] });
      await expect(updateCreditMemo(ctx, cm.id, { customerId: plainCust, date: D('2026-02-02'), refNumber: 'CM-DUP', lines: [L(5)] })).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertBooks(ctx);
    });

    it("numbers are per company: company B may reuse company A's number and has its own sequence", async () => {
      await createInvoice(ctx, { customerId: plainCust, date: D('2026-02-03'), refNumber: 'ISO-500', lines: [L()] });
      const custB = (await db.insert(customers).values({ companyId: ctxB.companyId, displayName: 'B Cust' }).returning())[0].id;
      const b1 = await createInvoice(ctxB, { customerId: custB, date: D('2026-02-03'), refNumber: 'ISO-500', lines: [{ description: 'b', quantity: 1, rate: 10, accountId: acctB['4000'] }] });
      expect(b1.refNumber).toBe('ISO-500');
      const b2 = await createInvoice(ctxB, { customerId: custB, date: D('2026-02-03'), refNumber: 'B-1', lines: [{ description: 'b', quantity: 1, rate: 10, accountId: acctB['4000'] }] });
      // Renumber B-1 to B's own existing number → conflict; to A-only number → fine.
      await expect(updateInvoice(ctxB, b2.id, { customerId: custB, date: D('2026-02-03'), refNumber: 'iso-500', lines: [{ description: 'b', quantity: 1, rate: 10, accountId: acctB['4000'] }] })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await nextDocNumber(ctxB, 'invoice')).toBe('B-2');
      await assertBooks(ctxB);
    });

    it('renumbering a posted, partly paid invoice keeps payments and the ledger whole', async () => {
      const payCust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Renumber Payer' }).returning())[0].id;
      const inv = await createInvoice(ctx, { customerId: payCust, date: D('2026-02-04'), dueDate: D('2026-03-06'), refNumber: 'PAID-1', lines: [L(100)] });
      await receivePayment(ctx, { customerId: payCust, date: D('2026-02-10'), method: 'check', reference: '501', amount: '40.00', depositAccountId: acct['1000'], applications: [{ invoiceId: inv.id, amountApplied: '40.00' }] });
      const upd = await updateInvoice(ctx, inv.id, { customerId: payCust, date: D('2026-02-04'), dueDate: D('2026-03-06'), refNumber: '  PAID-2  ', lines: [L(100)] });
      expect(upd.refNumber).toBe('PAID-2');
      const fresh = await getInvoice(ctx, inv.id);
      expect(fresh.amountPaid).toBe('40.00');
      expect(fresh.balanceDue).toBe('60.00');
      // The re-posted entry carries the new number.
      const lines = await db
        .select({ memo: journalEntryLines.memo, desc: journalEntries.description })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
        .where(and(eq(journalEntries.sourceRef, `invoice:${inv.id}`), eq(journalEntries.status, 'posted')));
      expect(lines.some((l) => `${l.memo ?? ''} ${l.desc ?? ''}`.includes('PAID-2'))).toBe(true);
      expect(lines.some((l) => `${l.memo ?? ''} ${l.desc ?? ''}`.includes('PAID-1'))).toBe(false);
      // Blank number keeps the current one.
      const keep = await updateInvoice(ctx, inv.id, { customerId: payCust, date: D('2026-02-04'), dueDate: D('2026-03-06'), refNumber: '', lines: [L(100)] });
      expect(keep.refNumber).toBe('PAID-2');
      expect(await openInvoices(ctx, payCust)).toBe(await customerArLedgerBalance(ctx, payCust));
      await assertBooks(ctx);
    });

    it('invoice API: POST carries retainage %; PATCH renumber to a duplicate is a 409 the UI recognises, then saves when confirmed', async () => {
      const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
      const mk = (refNumber: string) =>
        invoicesPOST(new NextRequest('http://localhost/api/invoices', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ customerId: plainCust, date: '2026-02-20', refNumber, taxRateId: null, retainagePercent: '10', lines: [{ description: 'w', quantity: 1, rate: '200', accountId: acct['4000'] }] }),
        }));
      const a = await mk('API-1');
      expect(a.status).toBe(201);
      const aBody = await json(a);
      expect(aBody.retainageAmount).toBe('20.00');
      const b = await json(await mk('API-2'));
      const patch = (body: Record<string, unknown>) =>
        invoicePATCH(new NextRequest(`http://localhost/api/invoices/${b.id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ customerId: plainCust, date: '2026-02-20', taxRateId: null, retainagePercent: '10', lines: [{ description: 'w', quantity: 1, rate: '200', accountId: acct['4000'] }], ...body }),
        }), { params: Promise.resolve({ id: String(b.id) }) });
      const conflict = await patch({ refNumber: 'api-1' });
      expect(conflict.status).toBe(409);
      const msg = String((await json(conflict)).error ?? '');
      // The form's duplicate detector (components/sales/DocNumberField.tsx) must match this message.
      const src = fs.readFileSync(path.resolve(process.cwd(), 'components', 'sales', 'DocNumberField.tsx'), 'utf8');
      const m = /err\.status === 409 && (\/.+?\/i)\.test/.exec(src);
      expect(m).not.toBeNull();
      const re = new RegExp(m![1].slice(1, -2), 'i');
      expect(re.test(msg)).toBe(true);
      expect((await getInvoice(ctx, String(b.id))).refNumber).toBe('API-2');
      const ok = await patch({ refNumber: 'API-1', allowDuplicateNumber: true });
      expect(ok.status).toBe(200);
      expect((await getInvoice(ctx, String(b.id))).refNumber).toBe('API-1');
      await assertBooks(ctx);
    });

    it('all six forms wire the number field and the duplicate-number confirm into create AND edit saves', () => {
      for (const page of ['estimates', 'sales-orders', 'sales-receipts', 'credit-memos', 'purchase-orders']) {
        const src = fs.readFileSync(path.resolve(process.cwd(), 'app', page, 'page.tsx'), 'utf8');
        expect(src, page).toMatch(/useDocNumber\(/);
        expect(src, page).toMatch(/<DocNumberField/);
        expect(src, page).toMatch(/useDuplicateNumberConfirm\(/);
        expect(src, page).toMatch(/refNumber: docNumber\.payload/);
        // Both the PATCH (edit) and POST (new) calls go through the confirm wrapper with allowDuplicateNumber.
        const call = /dupConfirm\.run\(\(allowDuplicateNumber\) =>([\s\S]*?)\n\s*\);/.exec(src)?.[1] ?? '';
        expect(call, page).toMatch(/api\.patch/);
        expect(call, page).toMatch(/api\.post/);
        expect((call.match(/allowDuplicateNumber/g) ?? []).length, page).toBeGreaterThanOrEqual(2);
        expect(src, page).toMatch(/\{dupConfirm\.dialog\}|dupConfirm\.dialog/);
      }
      const inv = fs.readFileSync(path.resolve(process.cwd(), 'app', 'invoices', 'page.tsx'), 'utf8');
      expect(inv).toMatch(/useDocNumber\('invoice'/);
      expect(inv).toMatch(/if \(refNumber\.trim\(\)\) payload\.refNumber/);
      expect(inv).toMatch(/if \(allowDuplicateNumber\) payload\.allowDuplicateNumber = true/);
    });

    it('renumbering in a closed period is refused and changes nothing (rollback)', async () => {
      const inv = await createInvoice(ctx, { customerId: plainCust, date: D('2026-01-15'), refNumber: 'CLOSED-1', lines: [L(50)] });
      await setClosing(ctx, '2026-01-31');
      try {
        await expect(
          updateInvoice(ctx, inv.id, { customerId: plainCust, date: D('2026-01-15'), refNumber: 'CLOSED-2', lines: [L(50)] }),
        ).rejects.toThrow();
        expect((await getInvoice(ctx, inv.id)).refNumber).toBe('CLOSED-1');
        // The number is still free afterwards.
        const other = await createInvoice(ctx, { customerId: plainCust, date: D('2026-02-15'), refNumber: 'CLOSED-2', lines: [L(1)] });
        expect(other.refNumber).toBe('CLOSED-2');
      } finally {
        await setClosing(ctx, null);
      }
      await assertBooks(ctx);
    });
  });

  // =================================================================== 2. tax defaults
  describe('customer default tax item / tax code', () => {
    it('sales receipt with the default tax item posts the tax to Sales Tax Payable', async () => {
      const before = Money.of(await accountBalance(ctx, '2200'));
      const sr = await createSalesReceipt(ctx, { customerId: taxCust, date: D('2026-03-01'), depositAccountId: acct['1000'], lines: [L(250)] });
      expect(sr.taxAmount).toBe('25.00');
      expect(sr.total).toBe('275.00');
      const after = Money.of(await accountBalance(ctx, '2200'));
      expect(before.minus(after).toFixed(2)).toBe('25.00'); // credit balance grew by 25
      await assertBooks(ctx);
    });

    it('non-taxable customer: edits of estimate, sales order, sales receipt and credit memo stay untaxed', async () => {
      const lines = [{ description: 'q', quantity: 1, rate: 100, taxable: true }];
      const est = await createEstimate(ctx, { customerId: nonCust, date: D('2026-03-02'), taxRateId: rate10, lines });
      expect(est.taxAmount).toBe('0.00');
      expect((await updateEstimate(ctx, est.id, { customerId: nonCust, date: D('2026-03-02'), taxRateId: rate10, lines })).taxAmount).toBe('0.00');
      const so = await createSalesOrder(ctx, { customerId: nonCust, date: D('2026-03-02'), taxRateId: rate10, lines });
      expect(so.taxAmount).toBe('0.00');
      expect((await updateSalesOrder(ctx, so.id, { customerId: nonCust, date: D('2026-03-02'), taxRateId: rate10, lines })).taxAmount).toBe('0.00');
      const sr = await createSalesReceipt(ctx, { customerId: nonCust, date: D('2026-03-02'), taxRateId: rate10, lines: [L(100, { taxable: true })] });
      expect(sr.taxAmount).toBe('0.00');
      expect((await updateSalesReceipt(ctx, sr.id, { customerId: nonCust, date: D('2026-03-02'), taxRateId: rate10, lines: [L(100, { taxable: true })] })).taxAmount).toBe('0.00');
      const cm = await createCreditMemo(ctx, { customerId: nonCust, date: D('2026-03-02'), taxRateId: rate10, lines: [L(100, { taxable: true })] });
      expect((await updateCreditMemo(ctx, cm.id, { customerId: nonCust, date: D('2026-03-02'), taxRateId: rate10, lines: [L(100, { taxable: true })] })).taxAmount).toBe('0.00');
      // Converting the estimate keeps it untaxed.
      const inv = await convertEstimate(ctx, est.id);
      expect(inv.taxAmount).toBe('0.00');
      expect(inv.total).toBe('100.00');
      await assertBooks(ctx);
    });

    it("switching an invoice to a non-taxable customer on edit drops the tax", async () => {
      const inv = await createInvoice(ctx, { customerId: taxCust, date: D('2026-03-03'), lines: [L(100)] });
      expect(inv.taxAmount).toBe('10.00');
      const upd = await updateInvoice(ctx, inv.id, { customerId: nonCust, date: D('2026-03-03'), taxRateId: rate10, lines: [L(100, { taxable: true })] });
      expect(upd.taxAmount).toBe('0.00');
      expect(upd.total).toBe('100.00');
      await assertBooks(ctx);
    });

    it('statement charges stay untaxed for a customer with a default tax item (QB: no tax on statement charges)', async () => {
      const ch = await createStatementCharge(ctx, { customerId: taxCust, date: D('2026-03-04'), accountId: acct['4000'], description: 'Late fee', rate: 15 });
      expect(ch.taxAmount).toBe('0.00');
      expect(ch.total).toBe('15.00');
    });

    it("changing the customer's tax item later does not re-tax existing documents", async () => {
      const cust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Rate Switch', taxRateId: rate10 }).returning())[0].id;
      const inv = await createInvoice(ctx, { customerId: cust, date: D('2026-03-05'), lines: [L(100)] });
      await updateCustomer(ctx, cust, { taxRateId: rate825 } as never);
      expect((await getInvoice(ctx, inv.id)).taxAmount).toBe('10.00');
      const inv2 = await createInvoice(ctx, { customerId: cust, date: D('2026-03-05'), lines: [L(100)] });
      expect(inv2.taxAmount).toBe('8.25');
    });

    it('sales-order tax rounds to the penny and the converted invoice matches', async () => {
      const so = await createSalesOrder(ctx, { customerId: plainCust, date: D('2026-03-06'), taxRateId: rate825, lines: [{ description: 'w', quantity: 3, rate: 33.33 }] });
      expect(so.taxAmount).toBe('8.25'); // 99.99 × 8.25% = 8.249175
      expect(so.total).toBe('108.24');
      const inv = await convertSalesOrder(ctx, so.id);
      expect(inv.taxAmount).toBe('8.25');
      expect(inv.total).toBe('108.24');
      await assertBooks(ctx);
    });
  });

  // =================================================================== 3. retainage
  describe('retainage', () => {
    let rcust: string;
    beforeAll(async () => {
      rcust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Contractor Client', taxRateId: rate10 }).returning())[0].id;
    });

    it('penny rounding: 7.5% of 333.33 holds 25.00; A/R, 1250 and the report all tie', async () => {
      const inv = await createInvoice(ctx, { customerId: rcust, date: D('2026-04-01'), taxRateId: null, retainagePercent: '7.5', lines: [L('333.33')] });
      expect(inv.retainageAmount).toBe('25.00');
      expect(inv.balanceDue).toBe('308.33');
      const rep = await retainageReport(ctx, { customerId: rcust });
      expect(rep.rows[0].open).toBe('25.00');
      expect(rep.ties).toBe(true);
      expect(await accountBalance(ctx, '1250')).toBe((await retainageReport(ctx)).accountBalance);
      expect(await openInvoices(ctx, rcust)).toBe(await customerArLedgerBalance(ctx, rcust));
      await assertBooks(ctx);
    });

    it('partial payment, then bill retainage (untaxed despite the default tax item), then pay it all → A/R 0', async () => {
      const inv = await createInvoice(ctx, { customerId: rcust, date: D('2026-04-02'), taxRateId: null, retainagePercent: 10, lines: [L(1000)] });
      expect(inv.balanceDue).toBe('900.00');
      await receivePayment(ctx, { customerId: rcust, date: D('2026-04-05'), method: 'check', reference: 'R1', amount: '500.00', depositAccountId: acct['1000'], applications: [{ invoiceId: inv.id, amountApplied: '500.00' }] });
      const bill = await billRetainage(ctx, { customerId: rcust, date: D('2026-04-10'), amount: '100' });
      expect(bill.taxAmount).toBe('0.00');
      expect(bill.total).toBe('100.00');
      // Customer A/R = 308.33 (first test) + 400 + 100
      expect(await customerArLedgerBalance(ctx, rcust)).toBe('808.33');
      expect(await openInvoices(ctx, rcust)).toBe('808.33');
      const aging = (await arAging(ctx, D('2026-04-30'))).rows.find((r) => r.id === rcust)?.total;
      expect(aging).toBe('808.33');
      const open = await getInvoice(ctx, inv.id);
      await receivePayment(ctx, {
        customerId: rcust, date: D('2026-04-20'), method: 'check', reference: 'R2', amount: '500.00', depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: open.balanceDue }, { invoiceId: bill.id, amountApplied: '100.00' }],
      });
      expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
      expect((await getInvoice(ctx, bill.id)).balanceDue).toBe('0.00');
      const rep = await retainageReport(ctx, { customerId: rcust });
      expect(rep.rows[0].open).toBe('25.00'); // 25 + 100 held − 100 billed
      expect(rep.ties).toBe(true);
      expect(await openInvoices(ctx, rcust)).toBe(await customerArLedgerBalance(ctx, rcust));
      await assertBooks(ctx);
    });

    it('billing retainage in a closed period is refused and leaves no invoice or audit row', async () => {
      const count = async () => Number((await db.select({ n: sql<number>`COUNT(*)` }).from(invoices).where(eq(invoices.companyId, ctx.companyId)))[0].n);
      const audits = async () => Number((await db.select({ n: sql<number>`COUNT(*)` }).from(auditLogs).where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'retainage_billing'))))[0].n);
      const n0 = await count();
      const a0 = await audits();
      await setClosing(ctx, '2026-04-30');
      try {
        await expect(billRetainage(ctx, { customerId: rcust, date: D('2026-04-15'), amount: '10' })).rejects.toThrow();
      } finally {
        await setClosing(ctx, null);
      }
      expect(await count()).toBe(n0);
      expect(await audits()).toBe(a0);
      expect((await retainageReport(ctx, { customerId: rcust })).rows[0].open).toBe('25.00');
    });

    it("is isolated per company: B sees no retainage and cannot bill A's customer", async () => {
      const rep = await retainageReport(ctxB);
      expect(rep.rows).toEqual([]);
      await expect(billRetainage(ctxB, { customerId: rcust, date: D('2026-05-01') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await retainageReport(ctx, { customerId: rcust })).rows[0].open).toBe('25.00');
    });

    it('foreign-currency invoices with retainage still tie the report to account 1250', async () => {
      // Own company: the generic integrity check sums invoice balances without exchange rates.
      const acctC: Record<string, string> = {};
      const ctxC = await newCompany('Adv SF FX Co', 'advsfc@t.local', acctC);
      const fx = (await db.insert(customers).values({ companyId: ctxC.companyId, displayName: 'FX Builder' }).returning())[0].id;
      const cases: Array<[string, string, string]> = [
        ['100.01', '1.115', '10'],
        ['333.33', '1.3337', '7'],
        ['12345.67', '0.7311', '5'],
        ['0.99', '1.4999', '33'],
      ];
      for (const [amt, rate, pct] of cases) {
        await createInvoice(ctxC, {
          customerId: fx, date: D('2026-05-02'), currency: 'EUR', exchangeRate: rate, taxRateId: null, retainagePercent: pct,
          lines: [L(amt, { accountId: acctC['4000'] }), L('17.17', { accountId: acctC['4000'] })],
        });
      }
      const rep = await retainageReport(ctxC);
      const row = rep.rows.find((r) => r.customerId === fx)!;
      expect(row.glOpen).toBe(row.open);
      expect(rep.ties).toBe(true);
      expect(rep.accountBalance).toBe(await accountBalance(ctxC, '1250'));
      expect((await trialBalance(ctxC)).balanced).toBe(true);
    });

    it('API: GET with a bad customerId / asOf is a 400, POST validates and bills', async () => {
      const bad = await retainageGET(new NextRequest('http://localhost/api/invoices/retainage?customerId=not-a-uuid'));
      expect([400, 404]).toContain(bad.status); // a refusal, not a crash
      const badDate = await retainageGET(new NextRequest('http://localhost/api/invoices/retainage?asOf=nope'));
      expect(badDate.status).toBe(400);
      const ok = await retainageGET(new NextRequest(`http://localhost/api/invoices/retainage?customerId=${rcust}`));
      expect(ok.status).toBe(200);
      expect((await ok.json()).rows[0].open).toBe('25.00');

      const post = (body: unknown) =>
        retainagePOST(new NextRequest('http://localhost/api/invoices/retainage', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
      expect((await post({ customerId: rcust })).status).toBe(400); // no date
      expect((await post({ customerId: rcust, date: '2026-05-03', amount: '25.01' })).status).toBe(400);
      const created = await post({ customerId: rcust, date: '2026-05-03', amount: '5.00', refNumber: 'RET-1' });
      expect(created.status).toBe(201);
      expect((await created.json()).refNumber).toBe('RET-1');
      // Duplicate number → 409 until confirmed.
      expect((await post({ customerId: rcust, date: '2026-05-03', amount: '5.00', refNumber: 'ret-1' })).status).toBe(409);
      expect((await post({ customerId: rcust, date: '2026-05-03', amount: '5.00', refNumber: 'RET-1', allowDuplicateNumber: true })).status).toBe(201);
      expect((await retainageReport(ctx, { customerId: rcust })).rows[0].open).toBe('15.00');
      await assertBooks(ctx);
    });
  });

  // =================================================================== 4. ship-to
  describe('ship-to addresses', () => {
    it('no default marked → the first address is the default; sales receipts default to it', async () => {
      const c = await createCustomer(ctx, {
        displayName: 'Two Sites',
        shipToAddresses: [{ name: 'North', line1: '1 North Rd' }, { name: 'South', line1: '2 South Rd' }],
      });
      expect(c.shipToAddresses?.map((a) => a.isDefault)).toEqual([true, false]);
      const sr = await createSalesReceipt(ctx, { customerId: c.id, date: D('2026-06-01'), lines: [L(10)] });
      expect(sr.shipTo).toEqual({ line1: '1 North Rd' });
    });

    it("an estimate's ship-to carries to the invoice it converts to", async () => {
      const c = await createCustomer(ctx, { displayName: 'Est Ship', shipToAddresses: [{ name: 'Main', line1: '9 Main', isDefault: true }] });
      const est = await createEstimate(ctx, { customerId: c.id, date: D('2026-06-02'), shipTo: { line1: '77 Job Site' }, taxRateId: null, lines: [{ description: 'q', quantity: 1, rate: 10 }] });
      const inv = await convertEstimate(ctx, est.id);
      expect(inv.shipTo).toEqual({ line1: '77 Job Site' });
    });

    it("editing only the customer's shipping address changes the ship-to new invoices default to", async () => {
      const c = await createCustomer(ctx, { displayName: 'Moved Co', shippingAddress: { line1: '1 Old St' } });
      await updateCustomer(ctx, c.id, { shippingAddress: { line1: '2 New Ave' } });
      const inv = await createInvoice(ctx, { customerId: c.id, date: D('2026-06-03'), lines: [L(10)] });
      // QB: the customer's (single) ship-to address was edited, so the new invoice ships there.
      expect(inv.shipTo).toEqual({ line1: '2 New Ave' });
    });

    it("packing slip prints the invoice's own ship-to, Ship Via and tracking number", async () => {
      const c = await createCustomer(ctx, { displayName: 'Slip Co', shipToAddresses: [{ name: 'Default', line1: '1 Default Way', isDefault: true }] });
      const inv = await createInvoice(ctx, {
        customerId: c.id, date: D('2026-06-04'), refNumber: 'SLIP/7', shipTo: { line1: '5 Dock St', city: 'Portside', state: 'CA', zip: '90001' },
        shipVia: 'UPS', trackingNumber: '1Z999', lines: [L(10)],
      });
      slipCalls.length = 0;
      const res = await packingSlipGET(new NextRequest(`http://localhost/api/invoices/${inv.id}/packing-slip`), { params: Promise.resolve({ id: inv.id }) });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Disposition')).toContain('packing-slip-SLIP_7.pdf');
      const args = slipCalls[0] as { shipToLines: string[]; shipping: { shipVia: string; trackingNumber: string }; slip: { invoiceNumber: string } };
      expect(args.shipToLines).toEqual(['5 Dock St', 'Portside, CA 90001']);
      expect(args.shipping.shipVia).toBe('UPS');
      expect(args.shipping.trackingNumber).toBe('1Z999');
      expect(args.slip.invoiceNumber).toBe('SLIP/7');
    });

    it('migration 0040 on an upgraded database: skips empty/non-object addresses, keeps existing lists, re-runs cleanly', async () => {
      const ins = async (name: string, shipping: unknown) =>
        (await db.insert(customers).values({ companyId: ctx.companyId, displayName: name, shippingAddress: shipping as never }).returning())[0].id;
      const empty = await ins('Mig Empty', {});
      const str = await ins('Mig String', 'just text');
      const keep = await ins('Mig Keep', { line1: '3 Keep Ln' });
      const fill = await ins('Mig Fill', { line1: '4 Fill Rd' });
      await db.execute(sql`UPDATE customers SET ship_to_addresses = NULL WHERE id IN (${empty}, ${str}, ${fill})`);
      const custom = [{ name: 'Custom', line1: 'Elsewhere', isDefault: true }];
      await db.execute(sql`UPDATE customers SET ship_to_addresses = ${JSON.stringify(custom)}::jsonb WHERE id = ${keep}`);
      const file = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0040_p1_salesforms.sql'), 'utf-8');
      const stmts = file.split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean);
      for (let pass = 0; pass < 2; pass++) for (const s of stmts) await db.execute(sql.raw(s));
      const get = async (id: string) => (await db.select().from(customers).where(eq(customers.id, id)))[0].shipToAddresses;
      expect(await get(empty)).toBeNull();
      expect(await get(str)).toBeNull();
      expect(await get(keep)).toEqual(custom);
      expect(await get(fill)).toEqual([{ name: 'Ship To 1', line1: '4 Fill Rd', isDefault: true }]);
      // Existing sales orders keep working after the re-run (new NOT NULL columns have defaults).
      const so = await createSalesOrder(ctx, { customerId: fill, date: D('2026-06-05'), lines: [{ description: 'x', quantity: 1, rate: 1 }] });
      expect(so.shipTo).toEqual({ line1: '4 Fill Rd' });
    });
  });

  // =================================================================== 5. statements
  describe('open-item statements', () => {
    let sc: string;
    beforeAll(async () => {
      sc = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Stmt Client' }).returning())[0].id;
    });

    const tieAt = async (asOf: Date) => {
      const st = await openItemStatement(ctx, sc, asOf);
      const gl = await customerArLedgerBalance(ctx, sc, asOf);
      const aging = (await arAging(ctx, asOf)).rows.find((r) => r.id === sc)?.total ?? '0.00';
      // statement == A/R aging == the customer's A/R in the general ledger, all as of the date
      expect({ statement: st.totalDue, aging }).toEqual({ statement: gl, aging: gl });
      return st;
    };

    it('a credit memo dated AFTER the statement date does not reduce it; a partial payment before it does', async () => {
      const inv = await createInvoice(ctx, { customerId: sc, date: D('2026-07-01'), dueDate: D('2026-07-31'), refNumber: 'ST-1', taxRateId: null, lines: [L(300)] });
      await receivePayment(ctx, { customerId: sc, date: D('2026-07-20'), method: 'check', reference: 'ST-P1', amount: '0.01', depositAccountId: acct['1000'], applications: [{ invoiceId: inv.id, amountApplied: '0.01' }] });
      const cm = await createCreditMemo(ctx, { customerId: sc, date: D('2026-08-05'), refNumber: 'ST-CM', taxRateId: null, lines: [L(70)] });
      await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '70.00', date: D('2026-08-05') });
      const st = await tieAt(D('2026-07-31'));
      const line = st.lines.find((l) => l.refNumber === 'ST-1')!;

      expect(line.balanceDue).toBe('299.99');
      expect(line.amountPaid).toBe('0.01');
      expect(st.lines.some((l) => l.refNumber === 'ST-CM')).toBe(false);
      expect(st.totalDue).toBe('299.99');
      const later = await tieAt(D('2026-08-31'));
      expect(later.lines.find((l) => l.refNumber === 'ST-1')!.balanceDue).toBe('229.99');
      expect(later.lines.some((l) => l.refNumber === 'ST-CM')).toBe(false);
    });

    it('retainage stays off the statement until billed; voided invoices and future-dated items are excluded', async () => {
      const held = await createInvoice(ctx, { customerId: sc, date: D('2026-07-10'), refNumber: 'ST-RET', taxRateId: null, retainagePercent: 10, lines: [L(1000)] });
      const voided = await createInvoice(ctx, { customerId: sc, date: D('2026-07-11'), refNumber: 'ST-VOID', taxRateId: null, lines: [L(55)] });
      await voidInvoice(ctx, voided.id);
      await createInvoice(ctx, { customerId: sc, date: D('2026-09-15'), refNumber: 'ST-FUTURE', taxRateId: null, lines: [L(11)] });
      const st = await tieAt(D('2026-08-31'));
      const ret = st.lines.find((l) => l.refNumber === 'ST-RET')!;
      expect(ret.total).toBe('900.00');
      expect(ret.balanceDue).toBe('900.00');
      expect(st.lines.some((l) => l.refNumber === 'ST-VOID' || l.refNumber === 'ST-FUTURE')).toBe(false);
      expect(st.totalDue).toBe('1129.99'); // 229.99 + 900
      await billRetainage(ctx, { customerId: sc, date: D('2026-09-01'), amount: '100', refNumber: 'ST-RB' });
      const after = await tieAt(D('2026-09-30'));
      expect(after.lines.find((l) => l.refNumber === 'ST-RB')!.balanceDue).toBe('100.00');
      expect(after.totalDue).toBe('1240.99');
      expect(held.balanceDue).toBe('900.00');
    });

    it('a General Journal credit to A/R for the customer is listed as an open credit and ties', async () => {
      await createManualEntry(ctx, {
        date: D('2026-09-20'),
        description: 'Goodwill credit',
        lines: [
          { accountId: acct['4000'], debit: '41.00' },
          { accountId: acct['1200'], credit: '41.00', entityType: 'customer', entityId: sc },
        ],
      });
      const st = await tieAt(D('2026-09-30'));
      const gj = st.lines.find((l) => l.type === 'general_journal')!;
      expect(gj.balanceDue).toBe('-41.00');
      expect(st.totalDue).toBe('1199.99');
      await assertBooks(ctx);
    });

    it("another company cannot pull this customer's statement", async () => {
      await expect(openItemStatement(ctxB, sc, D('2026-09-30'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
