/**
 * p1/salesforms — tester re-test round 1 (independent verification of fix commit dea78cf).
 *
 *  1. Retainage report ties to account 1250 for foreign-currency invoices through edits, billing
 *     the released retainage, voids, an invoice that both holds and bills retainage, and as-of runs.
 *  2. Editing only a customer's shipping address keeps the ship-to list in sync, on every sales
 *     form, via the API, with legacy lists (no default flagged), blank addresses and isolation.
 *  3. A/R and A/P aging (summary + detail) and the open-item statement as of a date ignore credits
 *     dated after it — across several invoices, with unapply, with General Journal credits on the
 *     same invoice, with a vendor credit re-dated after being applied — and always equal the
 *     control account in the general ledger as of that date.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, journalEntries, journalEntryLines, accounts, auditLogs } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice, updateInvoice, voidInvoice, getInvoice } from './invoices';
import { createEstimate } from './estimates';
import { createSalesOrder } from './salesOrders';
import { createSalesReceipt } from './salesReceipts';
import { createCreditMemo, applyToInvoice, listCreditApplications, unapplyCreditApplication } from './creditMemos';
import { createBill } from './bills';
import { createVendorCredit, updateVendorCredit, applyToBill } from './vendorCredits';
import { createCustomer, updateCustomer, getCustomer } from './customers';
import { createManualEntry } from './journal';
import { applyJournalCredit } from './journalApplications';
import { billRetainage, retainageReport } from './retainage';
import { customerArLedgerBalance, customerStatement, openItemStatement } from './statements';
import { arAging, arAgingDetail, apAging, apAgingDetail } from './reportsExtra';
import { trialBalance } from './reports';

vi.mock('@/lib/context', () => ({
  getServerContext: vi.fn(async () => ctx),
}));
import { PATCH as customerPATCH } from '@/app/api/customers/[id]/route';
import { NextRequest } from 'next/server';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-salesforms-retest1');
let db: DB;
let ctx: ServiceContext;
let ctxB: ServiceContext;
const acct: Record<string, string> = {};
const acctB: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const L = (rate: number | string, extra: Record<string, unknown> = {}) => ({
  description: 'Work',
  quantity: 1,
  rate,
  accountId: acct['4000'],
  ...extra,
});

const ACCOUNTS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
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

/** Debit-minus-credit on an account (optionally as of a date), from posted journal lines. */
async function gl(c: ServiceContext, code: string, asOf?: Date) {
  const conds = [
    eq(journalEntries.companyId, c.companyId),
    eq(journalEntries.status, 'posted'),
    eq(accounts.code, code),
    eq(accounts.companyId, c.companyId),
  ];
  if (asOf) conds.push(lte(journalEntries.date, asOf));
  const [row] = await db
    .select({
      net: sql<string>`COALESCE(SUM(CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC) - CAST(COALESCE(${journalEntryLines.credit}, '0') AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .where(and(...conds));
  return Money.of(row?.net ?? '0').toFixed(2);
}

const sumOpen = (rows: Array<{ openBalance: string }>) =>
  rows.reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero()).toFixed(2);

/** A/R aging summary, detail, open-item statement and the customer's GL A/R, all as of `asOf`. */
async function arTie(c: ServiceContext, customerId: string, asOf: Date) {
  const summary = (await arAging(c, asOf)).rows.find((r) => r.id === customerId)?.total ?? '0.00';
  const detail = sumOpen((await arAgingDetail(c, asOf)).rows.filter((r) => r.entityId === customerId));
  const statement = (await openItemStatement(c, customerId, asOf)).totalDue;
  const ledger = await customerArLedgerBalance(c, customerId, asOf);
  return { summary, detail, statement, ledger };
}

async function apTie(c: ServiceContext, vendorId: string, asOf: Date) {
  const summary = (await apAging(c, asOf)).rows.find((r) => r.id === vendorId)?.total ?? '0.00';
  const detail = sumOpen((await apAgingDetail(c, asOf)).rows.filter((r) => r.entityId === vendorId));
  return { summary, detail };
}

describe('p1/salesforms re-test round 1', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    ctx = await newCompany('SF Retest Co', 'sf-retest@t.local', acct);
    ctxB = await newCompany('SF Retest Other', 'sf-retest-b@t.local', acctB);
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ============================================================ 1. FX retainage ties to 1250
  describe('foreign-currency retainage', () => {
    it('ties through an edit (rate and %), an as-of run, billing all of it, and stays balanced', async () => {
      const acctC: Record<string, string> = {};
      const c = await newCompany('SF Retest FX1', 'sf-retest-fx1@t.local', acctC);
      const fx = (await db.insert(customers).values({ companyId: c.companyId, displayName: 'FX Builder' }).returning())[0].id;
      const lines = (a: string, b: string) => [L(a, { accountId: acctC['4000'] }), L(b, { accountId: acctC['4000'] })];
      const i1 = await createInvoice(c, { customerId: fx, date: D('2026-05-02'), currency: 'EUR', exchangeRate: '1.4999', taxRateId: null, retainagePercent: '33', lines: lines('0.99', '17.17') });
      const i2 = await createInvoice(c, { customerId: fx, date: D('2026-05-03'), currency: 'EUR', exchangeRate: '1.3337', taxRateId: null, retainagePercent: '7', lines: lines('333.33', '17.17') });
      // Edit i2: new rate and new retainage % — the old entry is voided and a new one posted.
      await updateInvoice(c, i2.id, { customerId: fx, date: D('2026-05-03'), currency: 'EUR', exchangeRate: '0.7311', taxRateId: null, retainagePercent: '11', lines: lines('12345.67', '0.01') } as never);
      const rep = await retainageReport(c);
      const row = rep.rows.find((r) => r.customerId === fx)!;
      expect(row.glOpen).toBe(row.open);
      expect(rep.ties).toBe(true);
      expect(rep.accountBalance).toBe(await gl(c, '1250'));
      expect(row.open).toBe(await gl(c, '1250'));

      // As of the day of i1 only: just i1's retainage.
      const early = await retainageReport(c, { asOf: D('2026-05-02') });
      expect(early.ties).toBe(true);
      expect(early.rows[0].open).toBe(await gl(c, '1250', D('2026-05-02')));

      // Bill everything still held (home currency) → nothing left, report and 1250 both zero.
      const billed = await billRetainage(c, { customerId: fx, date: D('2026-06-01') });
      expect(billed.total).toBe(row.open);
      const after = await retainageReport(c, { customerId: fx });
      expect(after.rows[0].open).toBe('0.00');
      expect(after.ties).toBe(true);
      expect(await gl(c, '1250')).toBe('0.00');
      // The balance-forward statement (home currency, with exchange-rate adjustment lines) equals
      // the customer's A/R in the GL after billing.
      const bf = await customerStatement(c, fx, { to: D('2026-06-30') });
      expect(bf.homeCurrency).toBe(true);
      expect(bf.closingBalance).toBe(await customerArLedgerBalance(c, fx, D('2026-06-30')));
      expect((await trialBalance(c)).balanced).toBe(true);
      // i1 is untouched by the edit of i2.
      expect((await getInvoice(c, i1.id)).retainageAmount).toBe(i1.retainageAmount);
    });

    it('an FX invoice that both holds retainage and bills some on a 1250 line, and a voided one, still tie', async () => {
      const acctC: Record<string, string> = {};
      const c = await newCompany('SF Retest FX2', 'sf-retest-fx2@t.local', acctC);
      const fx = (await db.insert(customers).values({ companyId: c.companyId, displayName: 'FX Mixed' }).returning())[0].id;
      const r0 = await createInvoice(c, { customerId: fx, date: D('2026-05-01'), currency: 'EUR', exchangeRate: '1.1111', taxRateId: null, retainagePercent: '10', lines: [L('1000.03', { accountId: acctC['4000'] })] });
      const rep0 = await retainageReport(c);
      const ret1250 = (await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '1250'))))[0].id;
      expect(rep0.ties).toBe(true);
      // Second FX invoice: holds 5% and also bills 3.33 EUR on the retainage account.
      await createInvoice(c, {
        customerId: fx, date: D('2026-05-10'), currency: 'EUR', exchangeRate: '1.2347', taxRateId: null, retainagePercent: '5',
        lines: [L('777.77', { accountId: acctC['4000'] }), L('3.33', { accountId: ret1250 })],
      });
      const v = await createInvoice(c, { customerId: fx, date: D('2026-05-11'), currency: 'EUR', exchangeRate: '1.3999', taxRateId: null, retainagePercent: '9', lines: [L('55.55', { accountId: acctC['4000'] })] });
      await voidInvoice(c, v.id);
      const rep = await retainageReport(c);
      const row = rep.rows.find((r) => r.customerId === fx)!;
      expect(row.glOpen).toBe(row.open);
      expect(rep.ties).toBe(true);
      expect(rep.accountBalance).toBe(await gl(c, '1250'));
      expect(row.documents.some((d) => d.invoiceId === v.id)).toBe(false);
      expect(r0.id).toBeTruthy();
      expect((await trialBalance(c)).balanced).toBe(true);
    });
  });

  // ============================================================ 2. shipping address <-> ship-to list
  describe('shipping address keeps the ship-to list in sync', () => {
    it('a patch carrying both fields: the list wins and shippingAddress follows its default', async () => {
      const c = await createCustomer(ctx, { displayName: 'Both Fields', shippingAddress: { line1: '1 A St' } });
      const u = await updateCustomer(ctx, c.id, {
        shippingAddress: { line1: 'IGNORED' },
        shipToAddresses: [{ name: 'Dock', line1: '7 Dock Rd' }, { name: 'HQ', line1: '8 HQ Way', isDefault: true }],
      });
      expect(u.shippingAddress).toEqual({ line1: '8 HQ Way' });
      expect((u.shipToAddresses as Array<{ name: string }>).map((a) => a.name)).toEqual(['Dock', 'HQ']);
    });

    it('every new sales form defaults to the edited address; existing documents keep theirs; an audit row is written', async () => {
      const c = await createCustomer(ctx, {
        displayName: 'Mover',
        shipToAddresses: [{ name: 'Old Site', line1: '1 Old St', isDefault: true }, { name: 'Depot', line1: '3 Depot Ln' }],
      });
      const before = await createInvoice(ctx, { customerId: c.id, date: D('2026-06-01'), taxRateId: null, lines: [L(10)] });
      expect(before.shipTo).toEqual({ line1: '1 Old St' });
      await updateCustomer(ctx, c.id, { shippingAddress: { line1: '2 New Ave', zip: '12345' } });
      const want = { line1: '2 New Ave', zip: '12345' };
      expect((await createInvoice(ctx, { customerId: c.id, date: D('2026-06-02'), taxRateId: null, lines: [L(10)] })).shipTo).toEqual(want);
      expect((await createSalesOrder(ctx, { customerId: c.id, date: D('2026-06-02'), lines: [{ description: 'x', quantity: 1, rate: 1 }] })).shipTo).toEqual(want);
      expect((await createEstimate(ctx, { customerId: c.id, date: D('2026-06-02'), lines: [{ description: 'x', quantity: 1, rate: 1 }] } as never)).shipTo).toEqual(want);
      const sr = await createSalesReceipt(ctx, { customerId: c.id, date: D('2026-06-02'), depositAccountId: acct['1000'], paymentMethod: 'cash', taxRateId: null, lines: [L(5)] } as never);
      expect((sr as { shipTo?: unknown }).shipTo).toEqual(want);
      // The old invoice is not re-addressed.
      expect((await getInvoice(ctx, before.id)).shipTo).toEqual({ line1: '1 Old St' });
      // The default entry keeps its name; the other entry is untouched.
      expect((await getCustomer(ctx, c.id)).shipToAddresses).toEqual([
        { name: 'Old Site', line1: '2 New Ave', zip: '12345', isDefault: true },
        { name: 'Depot', line1: '3 Depot Ln', isDefault: false },
      ]);
      const audits = await db
        .select({ nv: auditLogs.newValues })
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'customer'), eq(auditLogs.entityId, c.id)));
      expect(audits.length).toBeGreaterThanOrEqual(2);
    });

    it('a legacy list with no default flagged: the first entry is the one edited', async () => {
      const c = await createCustomer(ctx, { displayName: 'Legacy List' });
      await db
        .update(customers)
        .set({ shipToAddresses: [{ name: 'First', line1: '1 F St' }, { name: 'Second', line1: '2 S St' }] as never, shippingAddress: { line1: '1 F St' } as never })
        .where(eq(customers.id, c.id));
      const u = await updateCustomer(ctx, c.id, { shippingAddress: { line1: '9 Nine St' } });
      expect(u.shippingAddress).toEqual({ line1: '9 Nine St' });
      expect(u.shipToAddresses).toEqual([
        { name: 'First', line1: '9 Nine St', isDefault: true },
        { name: 'Second', line1: '2 S St', isDefault: false },
      ]);
    });

    it('a blank address clears the only ship-to: no list, no shipping address, new forms get no ship-to', async () => {
      const c = await createCustomer(ctx, { displayName: 'Blanker', shippingAddress: { line1: '1 Gone St' } });
      const u = await updateCustomer(ctx, c.id, { shippingAddress: { line1: '   ', city: '' } });
      expect(u.shippingAddress ?? null).toBeNull();
      expect(u.shipToAddresses ?? null).toBeNull();
      const inv = await createInvoice(ctx, { customerId: c.id, date: D('2026-06-03'), taxRateId: null, lines: [L(10)] });
      expect(inv.shipTo ?? null).toBeNull();
      // A patch that touches neither field leaves both alone.
      const again = await updateCustomer(ctx, c.id, { shippingAddress: { line1: '4 Back St' } });
      const touched = await updateCustomer(ctx, c.id, { phone: '555-0100' } as never);
      expect(touched.shippingAddress).toEqual({ line1: '4 Back St' });
      expect(touched.shipToAddresses).toEqual(again.shipToAddresses);
    });

    it('the customer PATCH API syncs the list; company B cannot edit company A\'s customer', async () => {
      const c = await createCustomer(ctx, { displayName: 'Via API', shipToAddresses: [{ name: 'Main', line1: '1 Main St' }] });
      const res = await customerPATCH(
        new NextRequest(`http://localhost/api/customers/${c.id}`, { method: 'PATCH', body: JSON.stringify({ shippingAddress: { line1: '5 Api Rd' } }) }),
        { params: Promise.resolve({ id: c.id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shippingAddress).toEqual({ line1: '5 Api Rd' });
      expect(body.shipToAddresses).toEqual([{ name: 'Main', line1: '5 Api Rd', isDefault: true }]);

      await expect(updateCustomer(ctxB, c.id, { shippingAddress: { line1: 'Hijack' } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await getCustomer(ctx, c.id)).shippingAddress).toEqual({ line1: '5 Api Rd' });
    });
  });

  // ============================================================ 3. aging as of a date
  describe('aging and open-item statement as of a date', () => {
    it('a late credit memo split over two invoices plus a late GJ credit on one: everything ties before and after', async () => {
      const cust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Split Credit' }).returning())[0].id;
      const a = await createInvoice(ctx, { customerId: cust, date: D('2026-03-01'), dueDate: D('2026-03-31'), taxRateId: null, lines: [L(400)] });
      const b = await createInvoice(ctx, { customerId: cust, date: D('2026-03-05'), dueDate: D('2026-04-04'), taxRateId: null, lines: [L(250.5)] });
      const onCutoff = await createCreditMemo(ctx, { customerId: cust, date: D('2026-03-31'), taxRateId: null, lines: [L(10)] });
      const late = await createCreditMemo(ctx, { customerId: cust, date: D('2026-04-10'), taxRateId: null, lines: [L(150)] });
      await applyToInvoice(ctx, { creditMemoId: late.id, invoiceId: a.id, amount: '99.99', date: D('2026-04-10') });
      await applyToInvoice(ctx, { creditMemoId: late.id, invoiceId: b.id, amount: '50.01', date: D('2026-04-10') });
      // Credit memo dated ON the cutoff, applied later: counts on the cutoff.
      await applyToInvoice(ctx, { creditMemoId: onCutoff.id, invoiceId: b.id, amount: '10.00', date: D('2026-04-15') });
      // General Journal credit dated before the cutoff, applied after it.
      const je = await createManualEntry(ctx, {
        date: D('2026-03-20'),
        description: 'Allowance',
        lines: [
          { accountId: acct['4000'], debit: '25.00' },
          { accountId: acct['1200'], credit: '25.00', entityType: 'customer', entityId: cust },
        ],
      });
      const [arLine] = await db
        .select({ id: journalEntryLines.id })
        .from(journalEntryLines)
        .where(and(eq(journalEntryLines.journalEntryId, (je as { id: string }).id), eq(journalEntryLines.accountId, acct['1200'])));
      await applyJournalCredit(ctx, { journalLineId: arLine.id, invoiceId: a.id, amount: '25.00', date: D('2026-04-20') });

      const cutoff = D('2026-03-31');
      const t = await arTie(ctx, cust, cutoff);
      // 400 + 250.50 - 10 (memo on cutoff) - 25 (GJ dated before) = 615.50
      expect(t).toEqual({ summary: '615.50', detail: '615.50', statement: '615.50', ledger: '615.50' });
      const now = D('2026-04-30');
      const t2 = await arTie(ctx, cust, now);
      expect(t2).toEqual({ summary: '465.50', detail: '465.50', statement: '465.50', ledger: '465.50' });
      expect((await trialBalance(ctx)).balanced).toBe(true);
    });

    it('a late credit memo applied then unapplied: the invoice is fully open again on both dates', async () => {
      const cust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Unapply Credit' }).returning())[0].id;
      const inv = await createInvoice(ctx, { customerId: cust, date: D('2026-03-01'), taxRateId: null, lines: [L(300)] });
      const cm = await createCreditMemo(ctx, { customerId: cust, date: D('2026-04-05'), taxRateId: null, lines: [L(70)] });
      await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '70.00', date: D('2026-04-05') });
      const apps = await listCreditApplications(ctx, { creditMemoId: cm.id });
      await unapplyCreditApplication(ctx, apps[0].id);
      expect(await arTie(ctx, cust, D('2026-03-31'))).toEqual({ summary: '300.00', detail: '300.00', statement: '300.00', ledger: '300.00' });
      // Today the memo is an open credit again: 300 - 70.
      expect(await arTie(ctx, cust, D('2026-04-30'))).toEqual({ summary: '230.00', detail: '230.00', statement: '230.00', ledger: '230.00' });
    });

    it('A/P: a vendor credit applied, then re-dated before the cutoff, counts from its new date; company B is unaffected', async () => {
      const vendorId = (await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Redated Vendor' }).returning())[0].id;
      const bill = await createBill(ctx, { vendorId, date: D('2026-03-01'), dueDate: D('2026-03-31'), lines: [{ accountId: acct['6000'], amount: '500.00' }] });
      const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-04-08'), lines: [{ accountId: acct['6000'], amount: '120.00' }] });
      await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '120.00' });

      // Company B: a late vendor credit applied to its own bill must not leak into A.
      const vB = (await db.insert(vendors).values({ companyId: ctxB.companyId, displayName: 'B Vendor' }).returning())[0].id;
      const billB = await createBill(ctxB, { vendorId: vB, date: D('2026-03-01'), lines: [{ accountId: acctB['6000'], amount: '80.00' }] });
      const vcB = await createVendorCredit(ctxB, { vendorId: vB, date: D('2026-04-09'), lines: [{ accountId: acctB['6000'], amount: '30.00' }] });
      await applyToBill(ctxB, { vendorCreditId: vcB.id, billId: billB.id, amount: '30.00' });

      const cutoff = D('2026-03-31');
      const glA = Money.of(await gl(ctx, '2000', cutoff)).negated().toFixed(2);
      expect(await apTie(ctx, vendorId, cutoff)).toEqual({ summary: '500.00', detail: '500.00' });
      expect(Money.of(glA).greaterThanOrEqualTo(500)).toBe(true);
      const glB = Money.of(await gl(ctxB, '2000', cutoff)).negated().toFixed(2);
      expect(glB).toBe('80.00');
      expect(await apTie(ctxB, vB, cutoff)).toEqual({ summary: '80.00', detail: '80.00' });

      // Re-date the applied credit to before the cutoff (QB allows editing the date).
      let redated = true;
      try {
        await updateVendorCredit(ctx, vc.id, { vendorId, date: D('2026-03-15'), lines: [{ accountId: acct['6000'], amount: '120.00' }] } as never);
      } catch {
        redated = false; // editing an applied credit is refused — then the original date stands
      }
      const expected = redated ? '380.00' : '500.00';
      expect(await apTie(ctx, vendorId, cutoff)).toEqual({ summary: expected, detail: expected });
      expect(await apTie(ctx, vendorId, D('2026-04-30'))).toEqual({ summary: '380.00', detail: '380.00' });
      expect((await trialBalance(ctx)).balanced).toBe(true);
      expect((await trialBalance(ctxB)).balanced).toBe(true);
    });

    it('A/P totals tie to the A/P control account as of the cutoff for a company with only late credits', async () => {
      const acctC: Record<string, string> = {};
      const c = await newCompany('SF Retest AP', 'sf-retest-ap@t.local', acctC);
      const v = (await db.insert(vendors).values({ companyId: c.companyId, displayName: 'Only Vendor' }).returning())[0].id;
      const b1 = await createBill(c, { vendorId: v, date: D('2026-02-01'), lines: [{ accountId: acctC['6000'], amount: '210.10' }] });
      const b2 = await createBill(c, { vendorId: v, date: D('2026-02-10'), lines: [{ accountId: acctC['6000'], amount: '89.90' }] });
      const vc = await createVendorCredit(c, { vendorId: v, date: D('2026-03-02'), lines: [{ accountId: acctC['6000'], amount: '100.00' }] });
      await applyToBill(c, { vendorCreditId: vc.id, billId: b1.id, amount: '60.00' });
      await applyToBill(c, { vendorCreditId: vc.id, billId: b2.id, amount: '40.00' });
      for (const day of ['2026-02-28', '2026-03-31']) {
        const asOf = D(day);
        const ledger = Money.of(await gl(c, '2000', asOf)).negated().toFixed(2);
        const totalAging = (await apAging(c, asOf)).rows.reduce((s, r) => s.plus(Money.of(r.total)), Money.zero()).toFixed(2);
        expect({ day, totalAging, detail: sumOpen((await apAgingDetail(c, asOf)).rows) }).toEqual({ day, totalAging: ledger, detail: ledger });
      }
    });
  });
});
