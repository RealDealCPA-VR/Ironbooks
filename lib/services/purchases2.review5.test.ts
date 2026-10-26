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

  it('Z: sanity — the helpers see the seeded accounts', async () => {
    expect(acct['1000']).toBeTruthy();
    expect(acct['5000']).toBeTruthy();
    const [row] = await db.select().from(items).limit(1);
    expect(row).toBeTruthy();
    expect(ServiceError).toBeTruthy();
  });
});
