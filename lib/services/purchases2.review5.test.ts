/**
 * Review round 5 (second pass) — purchases / A/P / checks / 1099 regressions.
 *
 *  A  FIFO items bought on a bill / check / returned-then-restored vendor credit: the cost layers
 *     carry exactly the amount the document posted to Inventory Asset, also when that amount is
 *     not quantity x a 4-decimal unit cost (1500 units for $50.00). Selling the units clears
 *     the inventory account to $0.00 instead of leaving cents behind.
 *  B  1099-NEC e-file / PDF follow the 1099 account mapping (rent mapped to MISC box 1 and
 *     unmapped accounts are not nonemployee compensation).
 *  C  Purchase order item lines print the item (the description defaults to it, as on bills).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  inventoryLayers,
  items,
  journalEntries,
  journalEntryLines,
  purchaseOrderLines,
  users,
  vendors,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createItem } from './items';
import { createBill, voidBill } from './bills';
import { createExpense } from './expenses';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { payBills } from './billPayments';
import { generate1099NecFile } from './form1099Xml';
import { set1099Mapping, vendor1099Worksheet } from './statements';
import { createPurchaseOrder, getPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';
import { createVendorCredit, voidVendorCredit } from './vendorCredits';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-purchases2');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function newVendor(extra: Partial<typeof vendors.$inferInsert> = {}) {
  seq += 1;
  const [v] = await db
    .insert(vendors)
    .values({ companyId: ctx.companyId, displayName: `R5B Vendor ${seq}`, ...extra })
    .returning();
  return v;
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

/** FIFO valuation of an item exactly as the valuation reports compute it (per-layer cents). */
async function layerValue(itemId: string): Promise<string> {
  const rows = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, itemId));
  const cents = rows.reduce((s, l) => s + Math.round(Number(l.quantityRemaining) * Number(l.unitCost) * 100), 0);
  return (cents / 100).toFixed(2);
}

/** A FIFO-tracked inventory item on its own inventory account (so the GL is the item's alone). */
async function fifoItem(name: string) {
  const { receiveStock } = await import('./fifo');
  seq += 1;
  const invAcct = (await createAccount(ctx, { code: `14${String(seq).padStart(2, '0')}`, name: `Inv ${name} ${seq}`, type: 'asset' as never, subtype: 'inventory' })).id;
  const item = await createItem(ctx, {
    name: `${name} ${seq}`,
    type: 'inventory',
    assetAccountId: invAcct,
    incomeAccountId: acct['4000'],
    cogsAccountId: acct['5000'],
  } as never);
  // One opening unit makes the item FIFO-tracked (it has layers); sold right away below.
  await receiveStock(ctx, { itemId: item.id, quantity: 1, unitCost: '1.00', date: d('2026-01-02') });
  return { item, invAcct };
}

describe('review5 purchases (second pass)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'r5b-purchases@test.local', name: 'R5B P', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R5B Purchases Co', ownerId: u.id });
    ctx = { db, companyId: company.id, userId: u.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
    if (!acct['4000']) {
      acct['4000'] = (await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue' as never, subtype: 'sales' })).id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('A: FIFO layers from a bill / check hold exactly what the document posted (bulk quantities)', async () => {
    const v = await newVendor();
    // Bill: 1500 screws for $50.00 (0.03333… each).
    const a = await fifoItem('Screws');
    const bill = await createBill(ctx, {
      vendorId: v.id,
      date: d('2026-02-01'),
      lines: [{ itemId: a.item.id, quantity: 1500, amount: '50.00' }],
    });
    expect(await layerValue(a.item.id)).toBe(await glBalance(a.invAcct));
    // A typed cost past 4 decimals: 3000 x 0.33333 = 999.99.
    const b = await fifoItem('Washers');
    await createBill(ctx, {
      vendorId: v.id,
      date: d('2026-02-01'),
      lines: [{ itemId: b.item.id, quantity: 3000, unitCost: '0.33333' }],
    });
    expect(await glBalance(b.invAcct)).toBe('1000.99');
    expect(await layerValue(b.item.id)).toBe(await glBalance(b.invAcct));
    // Check (Write Checks, Items tab).
    const c = await fifoItem('Bolts');
    await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-02-02'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ itemId: c.item.id, quantity: 7000, amount: '100.00' }],
    });
    expect(await layerValue(c.item.id)).toBe(await glBalance(c.invAcct));

    // Selling everything clears the inventory account to the cent.
    const cust = (await createCustomer(ctx, { displayName: `R5B cust ${++seq}` })).id;
    await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-02-10'),
      lines: [{ itemId: b.item.id, quantity: 3001, rate: '1.00' }],
    } as never);
    expect(await glBalance(b.invAcct)).toBe('0.00');

    // Voiding the bill takes out exactly what it put in (no rounding entry needed).
    const entriesBefore = (await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    await voidBill(ctx, bill.id);
    expect(await glBalance(a.invAcct)).toBe(await layerValue(a.item.id));
    expect(await glBalance(a.invAcct)).toBe('1.00');
    const entriesAfter = (await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    expect(entriesAfter).toBe(entriesBefore); // the void flips the bill's entry; no true-up posted
  });

  it('A2: voiding a vendor credit puts returned FIFO stock back at exactly the cost it left with', async () => {
    const { receiveStock } = await import('./fifo');
    const v = await newVendor();
    const x = await fifoItem('Nails');
    // Two layers at different 4dp costs: 1500 @ 0.0333 and 1500 @ 0.0334.
    await receiveStock(ctx, { itemId: x.item.id, quantity: 1500, unitCost: '0.0333', date: d('2026-03-01') });
    await receiveStock(ctx, { itemId: x.item.id, quantity: 1500, unitCost: '0.0334', date: d('2026-03-02') });
    const before = await glBalance(x.invAcct);
    expect(await layerValue(x.item.id)).toBe(before);
    const credit = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-03-05'),
      lines: [{ itemId: x.item.id, quantity: 3001, amount: '101.00' }],
    });
    expect(await layerValue(x.item.id)).toBe(await glBalance(x.invAcct));
    await voidVendorCredit(ctx, credit.id);
    expect(await glBalance(x.invAcct)).toBe(before);
    expect(await layerValue(x.item.id)).toBe(before);
  });

  it('B: the 1099-NEC e-file reports only the amounts mapped to NEC box 1', async () => {
    const rent = (await createAccount(ctx, { code: '6110', name: 'Rent B', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    const subs = (await createAccount(ctx, { code: '6010', name: 'Subcontractors B', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    const supplies = (await createAccount(ctx, { code: '6310', name: 'Supplies B', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    const landlord = await newVendor({ is1099: true, taxId: '11-1111111' });
    const contractor = await newVendor({ is1099: true, taxId: '22-2222222' });
    // Landlord: $12,000 rent (1099-MISC box 1), never nonemployee compensation.
    await createExpense(ctx, {
      vendorId: landlord.id,
      date: d('2026-04-01'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: rent, amount: '12000.00' }],
    });
    // Contractor: $900 of labor (NEC) + $5,000 of materials on an unmapped account, by bill.
    const bill = await createBill(ctx, {
      vendorId: contractor.id,
      date: d('2026-04-02'),
      lines: [
        { accountId: subs, amount: '900.00' },
        { accountId: supplies, amount: '5000.00' },
      ],
    });
    await payBills(ctx, {
      vendorId: contractor.id,
      date: d('2026-04-03'),
      method: 'check',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '5900.00' }],
    });
    await set1099Mapping(ctx, { boxes: [{ box: 'nec_1', accountIds: [subs] }, { box: 'misc_1', accountIds: [rent] }] });

    const ws = await vendor1099Worksheet(ctx, { year: 2026 });
    expect(ws.rows.find((r) => r.vendorId === contractor.id)?.nec1).toBe('900.00');

    const xml = await generate1099NecFile(ctx, { year: 2026 });
    // The landlord gets a 1099-MISC, not a 1099-NEC.
    expect(xml).not.toContain(`<Name>${landlord.displayName}</Name>`);
    const rec = xml.slice(xml.indexOf(`<Name>${contractor.displayName}</Name>`));
    expect(rec.slice(0, rec.indexOf('</Form1099NEC>'))).toContain('<NonemployeeCompensation>900.00</NonemployeeCompensation>');
    await set1099Mapping(ctx, { boxes: [] });
  });

  it('C: a purchase order item line without a description carries the item (printed for the vendor)', async () => {
    const v = await newVendor();
    seq += 1;
    const item = await createItem(ctx, {
      name: `Hex Bolt ${seq}`,
      type: 'non_inventory',
      description: 'Hex bolt M8 x 40, zinc',
      expenseAccountId: acct['6300'],
    } as never);
    const plain = await createItem(ctx, { name: `Gasket ${seq}`, type: 'non_inventory', expenseAccountId: acct['6300'] } as never);
    const po = await createPurchaseOrder(ctx, {
      vendorId: v.id,
      date: d('2026-05-01'),
      lines: [
        { itemId: item.id, quantity: 10, rate: '1.25' },
        { itemId: plain.id, quantity: 2, rate: '3.00', description: '' },
        { accountId: acct['6300'], quantity: 1, rate: '9.00', description: 'Freight' },
      ],
    });
    const got = await getPurchaseOrder(ctx, po.id);
    expect(got.lines.map((l) => l.description)).toEqual(['Hex bolt M8 x 40, zinc', plain.name, 'Freight']);
    // An edit that leaves the description blank keeps the item text too.
    const edited = await updatePurchaseOrder(ctx, po.id, {
      vendorId: v.id,
      date: d('2026-05-01'),
      lines: got.lines.map((l) => ({ id: l.id, itemId: l.itemId, accountId: l.accountId, quantity: l.quantity, rate: l.rate, description: null })),
    });
    const rows = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    expect(edited.lines.length).toBe(3);
    expect(rows.find((r) => r.itemId === item.id)?.description).toBe('Hex bolt M8 x 40, zinc');
    expect(rows.find((r) => !r.itemId)?.description).toBeNull();
  });

  it('D: a check taken out of the print queue by an edit never shares its number with a check written at the same time', async () => {
    const { updateExpense } = await import('./expenses');
    const { updateBillPayment } = await import('./billPayments');
    const bank = (await createAccount(ctx, { code: '1090', name: 'Race Checking', type: 'asset' as never, subtype: 'checking' })).id;
    const v = await newVendor();
    const line = [{ accountId: acct['6300'], amount: '10.00' }];
    await createExpense(ctx, { vendorId: v.id, date: d('2026-06-01'), method: 'check', reference: '5000', paymentAccountId: bank, lines: line });
    for (let i = 0; i < 3; i++) {
      // A check waiting in Print Checks (no number yet) …
      const queued = await createExpense(ctx, { vendorId: v.id, date: d('2026-06-02'), method: 'check', toPrint: true, paymentAccountId: bank, lines: line });
      expect(queued.reference).toBeNull();
      // … is edited to "not to be printed" (it takes the next number) while another check is written.
      const [edited, fresh] = await Promise.all([
        updateExpense(ctx, queued.id, { vendorId: v.id, date: d('2026-06-02'), method: 'check', toPrint: false, paymentAccountId: bank, lines: line }),
        createExpense(ctx, { vendorId: v.id, date: d('2026-06-02'), method: 'check', paymentAccountId: bank, lines: line }),
      ]);
      expect(edited.reference).toBeTruthy();
      expect(fresh.reference).toBeTruthy();
      expect(edited.reference).not.toBe(fresh.reference);
    }
    // Same for a queued bill payment check taken out of the queue by an edit.
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-06-01'), lines: [{ accountId: acct['6300'], amount: '500.00' }] });
    for (let i = 0; i < 3; i++) {
      const queued = await payBills(ctx, {
        vendorId: v.id,
        date: d('2026-06-03'),
        method: 'check',
        toPrint: true,
        paymentAccountId: bank,
        applications: [{ billId: bill.id, amountApplied: '5.00' }],
      });
      const [edited, fresh] = await Promise.all([
        updateBillPayment(ctx, queued.id, {
          vendorId: v.id,
          date: d('2026-06-03'),
          method: 'check',
          toPrint: false,
          paymentAccountId: bank,
          applications: [{ billId: bill.id, amountApplied: '5.00' }],
        }),
        createExpense(ctx, { vendorId: v.id, date: d('2026-06-03'), method: 'check', paymentAccountId: bank, lines: line }),
      ]);
      expect(edited.reference).toBeTruthy();
      expect(edited.reference).not.toBe(fresh.reference);
    }
  });

  it('E: Pay Liabilities / Pay Sales Tax refuse a memo or item name that is not text with a 400 (not a TypeError)', async () => {
    const { payPayrollLiabilities, paySalesTaxAgencies, payCreditCard } = await import('./liabilityPayments');
    const expectValidation = async (p: Promise<unknown>) => {
      const err = await p.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('VALIDATION');
    };
    const base = { date: d('2026-07-01'), paymentAccountId: acct['1000'] };
    await expectValidation(payPayrollLiabilities(ctx, { ...base, amount: '10.00', memo: 42 as never }));
    await expectValidation(payPayrollLiabilities(ctx, { ...base, items: [{ name: 7 as never, amount: '10.00' }] }));
    await expectValidation(payPayrollLiabilities(ctx, { ...base, items: [null as never] }));
    await expectValidation(payPayrollLiabilities(ctx, { ...base, amount: '10.00', payeeName: { a: 1 } as never }));
    await expectValidation(
      paySalesTaxAgencies(ctx, { ...base, payments: [{ agencyId: '00000000-0000-4000-8000-000000000001', amount: '5.00' }], memo: 5 as never }),
    );
    await expectValidation(payCreditCard(ctx, { ...base, creditCardAccountId: acct['2100'], amount: '5.00', memo: [] as never }));
  });

  it('F: the 1099-NEC e-file is never written with masked tax IDs (a Purchasing user is refused)', async () => {
    const { BUILTIN_ROLES, unionRoles } = await import('@/lib/permissions/model');
    const v = await newVendor({ is1099: true, taxId: '123-45-6789' });
    await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-08-01'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '800.00' }],
    });
    const purchasing: ServiceContext = { ...ctx, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === 'purchasing')) };
    const err = await generate1099NecFile(purchasing, { year: 2026 }).then(
      (xml) => xml,
      (e: unknown) => e,
    );
    // Before: the file carried "***-**-6789" as the TIN — a filing the IRS rejects.
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('FORBIDDEN');
    // A user who may see tax IDs gets the full TIN.
    const full = await generate1099NecFile(ctx, { year: 2026 });
    expect(full).toContain('<TaxId>123-45-6789</TaxId>');
  });

  it('G: a price variance capitalized into FIFO layers by a bill for received items moves inventory GL and valuation alike', async () => {
    const { createItemReceipt } = await import('./itemReceipts');
    const { enterBillForReceivedItems } = await import('./receiving');
    const v = await newVendor();
    const x = await fifoItem('Rivets');
    const receipt = await createItemReceipt(ctx, {
      vendorId: v.id,
      date: d('2026-09-01'),
      lines: [{ itemId: x.item.id, quantity: 3000, unitCost: '1.00' }],
    });
    expect(await layerValue(x.item.id)).toBe(await glBalance(x.invAcct));
    // The vendor bills 3001.00 (1.000333 each): 1.00 of price variance on stock still on hand.
    const bill = await enterBillForReceivedItems(ctx, {
      vendorId: v.id,
      date: d('2026-09-05'),
      lines: [{ receiptLineId: receipt.lines[0].id, quantity: 3000, unitCost: '1.000333' }],
    });
    expect(bill.total).toBe('3001.00');
    expect(await layerValue(x.item.id)).toBe(await glBalance(x.invAcct));
    // Partly billed line (split layer) too.
    const y = await fifoItem('Pins');
    const r2 = await createItemReceipt(ctx, {
      vendorId: v.id,
      date: d('2026-09-01'),
      lines: [{ itemId: y.item.id, quantity: 7000, unitCost: '0.50' }],
    });
    await enterBillForReceivedItems(ctx, {
      vendorId: v.id,
      date: d('2026-09-05'),
      lines: [{ receiptLineId: r2.lines[0].id, quantity: 3000, unitCost: '0.500333' }],
    });
    expect(await layerValue(y.item.id)).toBe(await glBalance(y.invAcct));
    // The re-costed units are still the receipt's: landed cost onto it capitalizes freight on all
    // 7000 units on hand (nothing to COGS as "already sold").
    const { allocateLandedCost } = await import('./landedCost');
    const freightAcct = (await createAccount(ctx, { code: '6060', name: 'Freight In G', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    const freight = await createBill(ctx, { vendorId: v.id, date: d('2026-09-06'), lines: [{ accountId: freightAcct, amount: '70.00' }] });
    const [fl] = await db.query.billLines.findMany({ where: (bl, { eq: e }) => e(bl.billId, freight.id) });
    const alloc = await allocateLandedCost(ctx, { billId: freight.id, billLineId: fl.id, method: 'quantity', itemReceiptIds: [r2.id] });
    expect(alloc.lines[0].cogsAmount).toBe('0.00');
    expect(await layerValue(y.item.id)).toBe(await glBalance(y.invAcct));
    // Voiding the bill puts layers and GL back together.
    await voidBill(ctx, bill.id);
    expect(await layerValue(x.item.id)).toBe(await glBalance(x.invAcct));
  });

  it('H: two vendors renamed to the same name at once — only one rename is kept', async () => {
    const { updateVendor } = await import('./vendors');
    for (let i = 0; i < 3; i++) {
      const a = await newVendor();
      const b = await newVendor();
      const name = `Same Name ${seq}-${i}`;
      const res = await Promise.allSettled([updateVendor(ctx, a.id, { displayName: name }), updateVendor(ctx, b.id, { displayName: name })]);
      const rows = await db.select().from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.displayName, name)));
      expect(rows).toHaveLength(1);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    }
  });

  it('I: Receive & Bill from a purchase order sends the bill date (today by default), not the PO date', async () => {
    // The service bills on the PO date when no date is given (API default); the PO screen's
    // Receive & Bill dialog had no date field, so every bill from a PO was dated when it was ordered.
    const src = fs.readFileSync(path.resolve(process.cwd(), 'app', 'purchase-orders', 'page.tsx'), 'utf8');
    const convert = src.slice(src.indexOf("action: 'convert'"), src.indexOf("action: 'convert'") + 400);
    expect(convert).toMatch(/date: billDate/);
    expect(convert).toMatch(/billNumber:/);
    expect(src).toMatch(/useState\(\(\) => todayISO\(\)\);\s*const \[billNumber/);
    // And the service honours it.
    const v = await newVendor();
    const po = await createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], quantity: 1, rate: '20.00' }] });
    const { convertToBill } = await import('./purchaseOrders');
    const bill = await convertToBill(ctx, po.id, { date: d('2026-04-15'), billNumber: 'INV-9' });
    expect(bill.date.toISOString().slice(0, 10)).toBe('2026-04-15');
    expect(bill.billNumber).toBe('INV-9');
  });

  it('J: Record Vendor Refund sends the deposit date the user sees (not the server clock)', async () => {
    // Without a date the service dates the refund "now" (a UTC instant: tomorrow, in the evening
    // in the Americas), and a refund received last month could not be dated at all.
    const src = fs.readFileSync(path.resolve(process.cwd(), 'app', 'vendor-credits', 'page.tsx'), 'utf8');
    const refund = src.slice(src.indexOf("action: 'refund'"), src.indexOf("action: 'refund'") + 200);
    expect(refund).toMatch(/date: refundDate/);
    expect(src).toMatch(/id="vc-refund-date"/);
    // Apply to Bill too (the application date drives A/P aging as of a date).
    const apply = src.slice(src.indexOf("action: 'apply'"), src.indexOf("action: 'apply'") + 200);
    expect(apply).toMatch(/date: applyDate/);
  });

  it('K: a purchase order with a no-charge ($0) line can be received and billed', async () => {
    const { convertToBill } = await import('./purchaseOrders');
    const v = await newVendor();
    const paid = await fifoItem('Toner');
    const free = await fifoItem('Sample Toner');
    const po = await createPurchaseOrder(ctx, {
      vendorId: v.id,
      date: d('2026-10-01'),
      lines: [
        { itemId: paid.item.id, quantity: 10, rate: '5.00' },
        { itemId: free.item.id, quantity: 2, rate: '0' },
        { accountId: acct['6300'], quantity: 1, rate: '0', description: 'Freight waived' },
      ],
    });
    // Before: "Line 2: amount must be greater than zero." — the PO could never be billed.
    const bill = await convertToBill(ctx, po.id, { date: d('2026-10-05') });
    expect(bill.total).toBe('50.00');
    const [freeRow] = await db.select().from(items).where(eq(items.id, free.item.id));
    expect(Number(freeRow.quantityOnHand)).toBe(3); // 1 opening + 2 free
    expect(await glBalance(free.invAcct)).toBe('1.00'); // no value added
    expect(await layerValue(free.item.id)).toBe('1.00');
    expect(await glBalance(paid.invAcct)).toBe('51.00');
    const got = await getPurchaseOrder(ctx, po.id);
    expect(got.status).toBe('closed');
    // Void takes the free units back out too.
    await voidBill(ctx, bill.id);
    const [after] = await db.select().from(items).where(eq(items.id, free.item.id));
    expect(Number(after.quantityOnHand)).toBe(1);
    // The Enter Bills / Receive Items forms accept a 0 cost too (else such a bill could not even get a memo edit).
    const billsPage = fs.readFileSync(path.resolve(process.cwd(), 'app', 'bills', 'page.tsx'), 'utf8');
    expect(billsPage.includes('Number(line.unitCost) >= 0')).toBe(true);
    expect(billsPage.includes('Number(line.unitCost) > 0 ?')).toBe(false);
    const receiptsPage = fs.readFileSync(path.resolve(process.cwd(), 'app', 'item-receipts', 'page.tsx'), 'utf8');
    expect(receiptsPage).not.toMatch(/line amount must be greater than zero/);
    // A bill of nothing but $0 lines is still refused.
    const err = await createBill(ctx, { vendorId: v.id, date: d('2026-10-05'), lines: [{ itemId: free.item.id, quantity: 1, unitCost: '0' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('VALIDATION');
  });

  it('L: items received at no charge on an item receipt (a $0 PO line) are stocked at $0', async () => {
    const { createItemReceipt, voidItemReceipt, convertToBill: receiptToBill } = await import('./itemReceipts');
    const v = await newVendor();
    const paid = await fifoItem('Ink');
    const free = await fifoItem('Sample Ink');
    const po = await createPurchaseOrder(ctx, {
      vendorId: v.id,
      date: d('2026-10-01'),
      lines: [
        { itemId: paid.item.id, quantity: 4, rate: '7.50' },
        { itemId: free.item.id, quantity: 2, rate: '0' },
      ],
    });
    // Before: "Line 2: line amount (quantity x unit cost) must be greater than zero."
    const receipt = await createItemReceipt(ctx, {
      vendorId: v.id,
      date: d('2026-10-03'),
      purchaseOrderId: po.id,
      lines: [
        { itemId: paid.item.id, quantity: 4, unitCost: '7.50' },
        { itemId: free.item.id, quantity: 2, unitCost: '0' },
      ],
    });
    expect(receipt.total).toBe('30.00');
    const [freeRow] = await db.select().from(items).where(eq(items.id, free.item.id));
    expect(Number(freeRow.quantityOnHand)).toBe(3);
    expect(await glBalance(free.invAcct)).toBe('1.00');
    expect(await layerValue(free.item.id)).toBe('1.00');
    // It converts to a bill (accrual relief only on the paid line) …
    const bill = await receiptToBill(ctx, receipt.id, { date: d('2026-10-04') });
    expect(bill.total).toBe('30.00');
    await voidBill(ctx, bill.id);
    // … and the receipt can be voided (stock back out).
    await voidItemReceipt(ctx, receipt.id);
    const [after] = await db.select().from(items).where(eq(items.id, free.item.id));
    expect(Number(after.quantityOnHand)).toBe(1);
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('open');
  });

  it('M: paychecks paid from a payroll bank account print and number on THAT account', async () => {
    const { createEmployee, runPaycheck } = await import('./payroll');
    const { updateCompany } = await import('./company');
    const { listPrintQueue, queuePaychecks, markPrinted } = await import('./printQueue');
    const { nextCheckNumber } = await import('./checkNumbers');
    const payroll = (await createAccount(ctx, { code: '1015', name: 'Payroll Checking', type: 'asset' as never, subtype: 'checking' })).id;
    const v = await newVendor();
    // Payroll Checking's own sequence starts at 3001; Checking (1000) is at 9001.
    await createExpense(ctx, { vendorId: v.id, date: d('2026-11-01'), method: 'check', reference: '3001', paymentAccountId: payroll, lines: [{ accountId: acct['6300'], amount: '1.00' }] });
    await createExpense(ctx, { vendorId: v.id, date: d('2026-11-01'), method: 'check', reference: '9001', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '1.00' }] });
    await updateCompany(ctx, { settings: { defaultPaycheckAccountId: payroll } } as never);
    const emp = await createEmployee(ctx, { firstName: 'Pat', lastName: `Payroll ${++seq}`, payType: 'salary', payRate: '52000.00' } as never);
    const pc = await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: d('2026-11-06'),
      grossPay: '1000.00',
      taxes: [],
      employerTaxes: [],
      deductions: [],
    } as never);
    await queuePaychecks(ctx, [pc.id]);
    // Print Checks for Payroll Checking lists the paycheck; Checking does not.
    const onPayroll = await listPrintQueue(ctx, { paymentAccountId: payroll });
    expect(onPayroll.some((q) => q.source === 'paycheck' && q.id === pc.id)).toBe(true);
    expect(onPayroll.find((q) => q.id === pc.id)?.paymentAccountId).toBe(payroll);
    const onChecking = await listPrintQueue(ctx, { paymentAccountId: acct['1000'] });
    expect(onChecking.some((q) => q.id === pc.id)).toBe(false);
    // Printing numbers it in Payroll Checking's sequence.
    const printed = (await markPrinted(ctx, { source: 'paycheck', id: pc.id })) as { checkNumber: string | null };
    expect(printed.checkNumber).toBe('3002');
    // And the next check number of each account follows its own checks.
    expect(await nextCheckNumber(ctx, payroll)).toBe('3003');
    expect(await nextCheckNumber(ctx, acct['1000'])).toBe('9002');
    await updateCompany(ctx, { settings: { defaultPaycheckAccountId: null } } as never);
  });

  it('N: YTD payroll summaries (mid-year setup) are not offered as paychecks to print', async () => {
    const { createEmployee } = await import('./payroll');
    const { createYtdAdjustment } = await import('./payrollAdjustments');
    const { listUnprintedPaychecks, queuePaychecks } = await import('./printQueue');
    const emp = await createEmployee(ctx, { firstName: 'Ytd', lastName: `Setup ${++seq}`, payType: 'salary', payRate: '60000.00' } as never);
    const ytd = await createYtdAdjustment(ctx, {
      employeeId: emp.id,
      date: d('2026-06-30'),
      lines: [
        { kind: 'earning', name: 'Salary', amount: '30000.00' },
        { kind: 'tax', name: 'Federal Withholding', amount: '4000.00' },
      ],
    });
    const list = await listUnprintedPaychecks(ctx);
    // Before: the $26,000 "net pay" of a year-to-date summary was listed under Add paychecks.
    expect(list.some((p) => p.id === (ytd as { id: string }).id)).toBe(false);
    const err = await queuePaychecks(ctx, [(ytd as { id: string }).id]).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
  });

  it('O: landed cost from a freight bill dated before the goods arrived posts when the goods are in stock', async () => {
    const { createItemReceipt } = await import('./itemReceipts');
    const { allocateLandedCost } = await import('./landedCost');
    const v = await newVendor();
    const x = await fifoItem('Crates');
    const freightAcct = (await createAccount(ctx, { code: '6070', name: 'Freight In O', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    // The freight forwarder bills on Dec 1; the goods arrive (item receipt) on Dec 10.
    const freight = await createBill(ctx, { vendorId: v.id, date: d('2026-12-01'), lines: [{ accountId: freightAcct, amount: '40.00' }] });
    const receipt = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-12-10'), lines: [{ itemId: x.item.id, quantity: 8, unitCost: '10.00' }] });
    const [fl] = await db.query.billLines.findMany({ where: (bl, { eq: e }) => e(bl.billId, freight.id) });
    const alloc = await allocateLandedCost(ctx, { billId: freight.id, billLineId: fl.id, method: 'quantity', itemReceiptIds: [receipt.id] });
    // Before: dated Dec 1 — inventory worth $40 more on days the crates were not in stock yet.
    expect(new Date(alloc.date).toISOString().slice(0, 10)).toBe('2026-12-10');
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, alloc.lines[0].entryId!));
    expect(entry.date.toISOString().slice(0, 10)).toBe('2026-12-10');
  });

  it('P: the landed cost charge list loads on a large company file (more lines than one query can bind)', async () => {
    const { listLandedCostSources } = await import('./landedCost');
    const { sql: rawSql } = await import('drizzle-orm');
    const v = await newVendor();
    const big = await createBill(ctx, { vendorId: v.id, date: d('2026-01-15'), lines: [{ accountId: acct['6300'], amount: '1.00' }] });
    // 70,000 more expense lines (years of bills): past Postgres' 65,535 bind parameters per query.
    await db.execute(rawSql`
      INSERT INTO bill_lines (bill_id, account_id, description, quantity, amount, line_order)
      SELECT ${big.id}::uuid, ${acct['6300']}::uuid, 'Bulk line ' || g, 1, 1.00, g FROM generate_series(1, 70000) AS g`);
    const sources = await listLandedCostSources(ctx, {});
    expect(sources.filter((s) => s.billId === big.id).length).toBe(70001);
    await db.execute(rawSql`DELETE FROM bill_lines WHERE bill_id = ${big.id}::uuid AND description LIKE 'Bulk line %'`);
  });

  it('Q: a vendor credit applied to the wrong bill can be unapplied from the Vendor Credits screen', async () => {
    const { applyToBill, getVendorCredit, unapplyFromBill } = await import('./vendorCredits');
    const v = await newVendor();
    const credit = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-05-01'), lines: [{ accountId: acct['6300'], amount: '60.00' }] });
    const b1 = await createBill(ctx, { vendorId: v.id, billNumber: 'Q-1', date: d('2026-05-02'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    const b2 = await createBill(ctx, { vendorId: v.id, billNumber: 'Q-2', date: d('2026-05-03'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    await applyToBill(ctx, { vendorCreditId: credit.id, billId: b1.id, amount: '40.00' });
    await applyToBill(ctx, { vendorCreditId: credit.id, billId: b2.id, amount: '20.00' });
    await unapplyFromBill(ctx, { vendorCreditId: credit.id, billId: b2.id, amount: '5.00' });
    // The credit's detail lists where it is applied (what the screen shows with an Unapply button).
    const detail = await getVendorCredit(ctx, credit.id);
    expect(detail.applications.map((a) => [a.billNumber, a.amount])).toEqual([
      ['Q-1', '40.00'],
      ['Q-2', '15.00'],
    ]);
    // Unapplying everything lets the credit be voided again.
    for (const a of detail.applications) await unapplyFromBill(ctx, { vendorCreditId: credit.id, billId: a.billId, amount: a.amount });
    expect((await getVendorCredit(ctx, credit.id)).applications).toEqual([]);
    await voidVendorCredit(ctx, credit.id);
    // The screen offers it (before: "Unapply first" with no way to unapply).
    const src = fs.readFileSync(path.resolve(process.cwd(), 'app', 'vendor-credits', 'page.tsx'), 'utf8');
    expect(src).toContain("action: 'unapply'");
  });

  it('Z: sanity — the helpers see the seeded accounts', async () => {
    expect(acct['1000']).toBeTruthy();
    expect(acct['5000']).toBeTruthy();
    const [row] = await db.select().from(items).limit(1);
    expect(row).toBeTruthy();
    expect(ServiceError).toBeTruthy();
  });
});
