/**
 * p1/salesforms: typed document numbers on edit (all six numbered forms), customer sales-tax
 * defaults (tax item + non-taxable tax code) and sales tax on sales orders.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { eq, sql } from 'drizzle-orm';
import { users, companies, customers, vendors, taxRates, taxAgencies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice, updateInvoice, getInvoice } from './invoices';
import { createEstimate, updateEstimate } from './estimates';
import { createSalesOrder, updateSalesOrder, getSalesOrder, convertToInvoice } from './salesOrders';
import { createSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createCreditMemo, updateCreditMemo } from './creditMemos';
import { createPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';
import { nextDocNumber } from './docNumbers';
import { createCustomer, updateCustomer } from './customers';
import { normalizeShipToAddresses, defaultShipTo } from '@/lib/shipTo';
import { trialBalance } from './reports';
import { runGlobalSearch } from '@/app/api/search/queries';
import { buildResults } from '@/app/api/search/results';
import { listAvailableCredits } from './payments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-salesforms');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let taxCust: string; // default tax item 10%
let nonCust: string; // tax code Non
let plainCust: string;
let vendorId: string;
let rate10: string;

const D = (s: string) => new Date(s);

describe('p1/salesforms — numbers and tax defaults', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1sf@t.local', name: 'S', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'P1 SF Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6000', 'Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [agency] = await db
      .insert(taxAgencies)
      .values({ companyId: c.id, name: 'State', liabilityAccountId: acct['2200'] })
      .returning();
    const [tr] = await db
      .insert(taxRates)
      .values({ companyId: c.id, name: 'Tax 10%', rate: '0.100000', agencyId: agency.id })
      .returning();
    rate10 = tr.id;
    taxCust = (await db.insert(customers).values({ companyId: c.id, displayName: 'Taxed', taxRateId: rate10 }).returning())[0].id;
    nonCust = (await db.insert(customers).values({ companyId: c.id, displayName: 'Exempt', taxable: false, taxRateId: rate10 }).returning())[0].id;
    plainCust = (await db.insert(customers).values({ companyId: c.id, displayName: 'Plain' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId: c.id, displayName: 'Supplier' }).returning())[0].id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const line = { description: 'Work', quantity: 1, rate: 100, accountId: undefined as string | undefined };

  // ---------------------------------------------------------------- tax defaults
  it("invoice: omitted tax item → the customer's default; explicit null → no tax", async () => {
    const a = await createInvoice(ctx, { customerId: taxCust, date: D('2026-05-01'), lines: [{ ...line }] });
    expect(a.taxRateId).toBe(rate10);
    expect(a.taxAmount).toBe('10.00');
    const b = await createInvoice(ctx, { customerId: taxCust, date: D('2026-05-01'), taxRateId: null, lines: [{ ...line }] });
    expect(b.taxAmount).toBe('0.00');
  });

  it('a customer with a non-taxable tax code is never taxed, even with a tax item', async () => {
    const inv = await createInvoice(ctx, { customerId: nonCust, date: D('2026-05-01'), taxRateId: rate10, lines: [{ ...line, taxable: true }] });
    expect(inv.taxAmount).toBe('0.00');
    expect(inv.total).toBe('100.00');
    const edited = await updateInvoice(ctx, inv.id, { customerId: nonCust, date: D('2026-05-01'), taxRateId: rate10, lines: [{ ...line, rate: 200, taxable: true }] });
    expect(edited.taxAmount).toBe('0.00');
  });

  it('estimate, sales receipt and credit memo default the tax item too', async () => {
    const est = await createEstimate(ctx, { customerId: taxCust, date: D('2026-05-01'), lines: [{ description: 'Q', quantity: 1, rate: 100 }] });
    expect(est.taxAmount).toBe('10.00');
    const sr = await createSalesReceipt(ctx, { customerId: taxCust, date: D('2026-05-01'), lines: [{ description: 'S', quantity: 1, rate: 100, accountId: acct['4000'] }] });
    expect(sr.taxAmount).toBe('10.00');
    const cm = await createCreditMemo(ctx, { customerId: taxCust, date: D('2026-05-01'), lines: [{ description: 'R', quantity: 1, rate: 100, accountId: acct['4000'] }] });
    expect(cm.taxAmount).toBe('10.00');
    const cmNon = await createCreditMemo(ctx, { customerId: nonCust, date: D('2026-05-01'), lines: [{ description: 'R', quantity: 1, rate: 100, accountId: acct['4000'] }] });
    expect(cmNon.taxAmount).toBe('0.00');
  });

  it('sales orders carry sales tax (customer default) onto the invoice they convert to', async () => {
    const so = await createSalesOrder(ctx, {
      customerId: taxCust,
      date: D('2026-05-02'),
      lines: [
        { description: 'Taxed', quantity: 2, rate: 50 },
        { description: 'Labor', quantity: 1, rate: 100, taxable: false },
      ],
    });
    expect(so.taxRateId).toBe(rate10);
    expect(so.taxAmount).toBe('10.00');
    expect(so.total).toBe('210.00');
    const inv = await convertToInvoice(ctx, so.id);
    expect(inv.taxRateId).toBe(rate10);
    expect(inv.taxAmount).toBe('10.00');
    expect(inv.total).toBe('210.00');

    const plain = await createSalesOrder(ctx, { customerId: plainCust, date: D('2026-05-02'), lines: [{ description: 'x', quantity: 1, rate: 100 }] });
    expect(plain.taxAmount).toBe('0.00');
    const upd = await updateSalesOrder(ctx, plain.id, { customerId: plainCust, date: D('2026-05-02'), taxRateId: rate10, lines: [{ description: 'x', quantity: 1, rate: 100 }] });
    expect(upd.taxAmount).toBe('10.00');
    expect(upd.total).toBe('110.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  // ---------------------------------------------------------------- typed numbers on edit
  it('invoice edit: retype the number; a duplicate needs confirmation', async () => {
    const a = await createInvoice(ctx, { customerId: plainCust, date: D('2026-05-03'), refNumber: 'JOB-100', lines: [{ ...line }] });
    const b = await createInvoice(ctx, { customerId: plainCust, date: D('2026-05-03'), refNumber: 'JOB-200', lines: [{ ...line }] });
    // keep the number when it is omitted or unchanged
    const same = await updateInvoice(ctx, a.id, { customerId: plainCust, date: D('2026-05-03'), refNumber: 'JOB-100', lines: [{ ...line }] });
    expect(same.refNumber).toBe('JOB-100');
    await expect(
      updateInvoice(ctx, b.id, { customerId: plainCust, date: D('2026-05-03'), refNumber: 'job-100', lines: [{ ...line }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { duplicateDocNumber: true } });
    const dup = await updateInvoice(ctx, b.id, { customerId: plainCust, date: D('2026-05-03'), refNumber: 'JOB-100', allowDuplicateNumber: true, lines: [{ ...line }] });
    expect(dup.refNumber).toBe('JOB-100');
    const renum = await updateInvoice(ctx, b.id, { customerId: plainCust, date: D('2026-05-03'), refNumber: 'JOB-777', lines: [{ ...line }] });
    expect(renum.refNumber).toBe('JOB-777');
    expect(renum.invoiceNumber).toBe(777);
    expect((await getInvoice(ctx, b.id)).refNumber).toBe('JOB-777');
    expect(await nextDocNumber(ctx, 'invoice')).toBe('JOB-778');
  });

  it('estimate, sales order, sales receipt, credit memo and PO can be renumbered on edit', async () => {
    const est = await createEstimate(ctx, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'Q-2026-17', lines: [{ description: 'Q', quantity: 1, rate: 10 }] });
    expect(est.refNumber).toBe('Q-2026-17');
    const est2 = await updateEstimate(ctx, est.id, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'Q-2026-18', lines: [{ description: 'Q', quantity: 1, rate: 10 }] });
    expect(est2.refNumber).toBe('Q-2026-18');

    const so = await createSalesOrder(ctx, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'SO-1', lines: [{ description: 'x', quantity: 1, rate: 10 }] });
    const so2 = await createSalesOrder(ctx, { customerId: plainCust, date: D('2026-05-04'), lines: [{ description: 'x', quantity: 1, rate: 10 }] });
    expect(so2.refNumber).toBe('SO-2');
    await expect(
      updateSalesOrder(ctx, so2.id, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'SO-1', lines: [{ description: 'x', quantity: 1, rate: 10 }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await updateSalesOrder(ctx, so.id, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'SO-A', lines: [{ description: 'x', quantity: 1, rate: 10 }] });
    expect((await getSalesOrder(ctx, so.id)).refNumber).toBe('SO-A');

    const sr = await createSalesReceipt(ctx, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'SR-1', lines: [{ description: 's', quantity: 1, rate: 10, accountId: acct['4000'] }] });
    const sr2 = await updateSalesReceipt(ctx, sr.id, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'SR-9', lines: [{ description: 's', quantity: 1, rate: 10, accountId: acct['4000'] }] });
    expect(sr2.refNumber).toBe('SR-9');

    const cm = await createCreditMemo(ctx, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'CM-1', lines: [{ description: 'r', quantity: 1, rate: 10, accountId: acct['4000'] }] });
    const cm2 = await updateCreditMemo(ctx, cm.id, { customerId: plainCust, date: D('2026-05-04'), refNumber: 'CM-5', lines: [{ description: 'r', quantity: 1, rate: 10, accountId: acct['4000'] }] });
    expect(cm2.refNumber).toBe('CM-5');

    const po = await createPurchaseOrder(ctx, { vendorId, date: D('2026-05-04'), refNumber: 'PO-77', lines: [{ accountId: acct['6000'], quantity: 1, rate: 5 }] });
    expect(po.refNumber).toBe('PO-77');
    const po2 = await updatePurchaseOrder(ctx, po.id, { vendorId, date: D('2026-05-04'), refNumber: 'PO-78', lines: [{ accountId: acct['6000'], quantity: 1, rate: 5 }] });
    expect(po2.refNumber).toBe('PO-78');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  // ---------------------------------------------------------------- ship-to addresses
  it('customers keep several named ship-to addresses; new sales forms default to the default one', async () => {
    const cust = await createCustomer(ctx, {
      displayName: 'Multi Site',
      shipToAddresses: [
        { name: 'Main', line1: '1 Main St', city: 'Springfield' },
        { name: 'Warehouse', line1: '9 Dock Rd', city: 'Shelbyville', isDefault: true },
      ],
    });
    expect(cust.shipToAddresses).toHaveLength(2);
    expect(cust.shippingAddress).toEqual({ line1: '9 Dock Rd', city: 'Shelbyville' });
    await expect(
      updateCustomer(ctx, cust.id, { shipToAddresses: [{ name: 'A', line1: 'x' }, { name: 'a', line1: 'y' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const inv = await createInvoice(ctx, { customerId: cust.id, date: D('2026-05-05'), lines: [{ ...line }] });
    expect(inv.shipTo).toEqual({ line1: '9 Dock Rd', city: 'Shelbyville' });
    const so = await createSalesOrder(ctx, { customerId: cust.id, date: D('2026-05-05'), lines: [{ description: 'x', quantity: 1, rate: 1 }] });
    expect(so.shipTo).toEqual({ line1: '9 Dock Rd', city: 'Shelbyville' });
    const est = await createEstimate(ctx, { customerId: cust.id, date: D('2026-05-05'), shipTo: { line1: '1 Main St', city: 'Springfield' }, lines: [{ description: 'x', quantity: 1, rate: 1 }] });
    expect(est.shipTo).toEqual({ line1: '1 Main St', city: 'Springfield' });
    // An explicit null means "no ship-to".
    const none = await createInvoice(ctx, { customerId: cust.id, date: D('2026-05-05'), shipTo: null, lines: [{ ...line }] });
    expect(none.shipTo).toBeNull();

    // Legacy single shipping address becomes "Ship To 1".
    const legacy = await createCustomer(ctx, { displayName: 'Legacy', shippingAddress: { line1: '5 Old Rd' } });
    expect(legacy.shipToAddresses).toEqual([{ name: 'Ship To 1', line1: '5 Old Rd', isDefault: true }]);
  });

  it('normalizeShipToAddresses names rows, keeps one default and drops blanks', () => {
    const out = normalizeShipToAddresses([{ line1: 'a' }, { name: '', line1: '' }, { name: 'B', line1: 'b', isDefault: true }, { name: 'C', line1: 'c', isDefault: true }])!;
    expect(out.map((a) => a.name)).toEqual(['Ship To 1', 'B', 'C']);
    expect(out.map((a) => a.isDefault)).toEqual([false, true, false]);
    expect(defaultShipTo(out)).toEqual({ line1: 'b' });
    expect(normalizeShipToAddresses([])).toBeNull();
  });

  it('global search finds estimates, sales orders, receipts, credit memos and POs by their typed number', async () => {
    const hits = await runGlobalSearch(db, ctx.companyId, 'Q-2026');
    expect(hits.docs?.some((d) => d.kind === 'estimate' && d.num === 'Q-2026-18')).toBe(true);
    const res = buildResults(await runGlobalSearch(db, ctx.companyId, 'PO-78'));
    expect(res.some((r) => r.type === 'Purchase Order' && r.label === 'Purchase Order #PO-78')).toBe(true);
    const inv = buildResults(await runGlobalSearch(db, ctx.companyId, 'JOB-777'));
    expect(inv.some((r) => r.label === 'Invoice #JOB-777')).toBe(true);
  });

  it('Receive Payments credit picker shows the typed credit memo number', async () => {
    await createCreditMemo(ctx, { customerId: plainCust, date: D('2026-05-06'), refNumber: 'RMA-42', lines: [{ description: 'r', quantity: 1, rate: 5, accountId: acct['4000'] }] });
    const credits = await listAvailableCredits(ctx, plainCust);
    expect(credits.some((c) => c.ref === 'Credit Memo #RMA-42')).toBe(true);
  });

  it('migration 0040 is idempotent and backfills a lone shipping address as the default ship-to', async () => {
    const [legacy] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Pre-0040', shippingAddress: { line1: '7 Upgrade Way', city: 'Oldtown' } })
      .returning();
    await db.execute(sql`UPDATE customers SET ship_to_addresses = NULL WHERE id = ${legacy.id}`);
    const file = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0040_p1_salesforms.sql'), 'utf-8');
    for (const stmt of file.split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean)) {
      await db.execute(sql.raw(stmt));
    }
    const [row] = await db.select().from(customers).where(eq(customers.id, legacy.id));
    expect(row.shipToAddresses).toEqual([{ name: 'Ship To 1', line1: '7 Upgrade Way', city: 'Oldtown', isDefault: true }]);
  });
});
