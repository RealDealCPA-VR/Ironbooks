/**
 * Review round 4 — regression tests for the product bugs found by the invariant fuzzer
 * (lib/services/invariants.fuzz.test.ts). Each test is the fuzzer's shrunk operation sequence,
 * re-written with explicit inputs, asserting the cross-module invariant it used to break:
 *
 *  1. FIFO reversals take back the document's OWN layers (tagged with its sourceRef) — not
 *     whatever layer happens to match a recomputed unit cost — and refuse when those units were sold.
 *  2. A void that would take more value off the inventory account than the stock still carries
 *     (written down / revalued since) is refused instead of clamping the average or layer cost.
 *  3. A bounced check's re-charge stays on the customer in the name-based reports.
 *  4. As-of A/R aging: a prepayment applied later to a later invoice is still a credit before it.
 *  5. As-of A/R aging: a foreign invoice settled on the cutoff is never aged in foreign units as home.
 *  6. A deposit cannot be dated before the money in it was received.
 *  7. As-of A/R aging before a bounce keeps the bounced payment's credit (also when the reopened
 *     invoice is edited down afterwards).
 *  8. Average-cost value remainders (0061) survive builds / unbuilds, value adjustments, credit-memo
 *     restocks and sales voids: GL 1300 = valuation + remainders, and a sell-out clears it to $0.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, items as itemsTable, users } from '@/lib/db/schema';
import { buildAssembly, setBom, unbuildAssembly } from './assemblies';
import { createSalesReceipt, voidSalesReceipt } from './salesReceipts';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { applyPayment, receivePayment, recordBouncedCheck, unapplyFromInvoice } from './payments';
import { createAccount } from './accounts';
import { setAccountCurrency, setBaseCurrency, upsertCurrency } from './currencies';
import { createItem } from './items';
import { createBill, updateBill, voidBill } from './bills';
import { createCreditMemo, voidCreditMemo } from './creditMemos';
import { consumeStock, receiveStock } from './fifo';
import { adjustInventory, inventoryValuation } from './inventory';
import { adjustInventoryValue } from './inventoryOps';
import { createItemReceipt, voidItemReceipt } from './itemReceipts';
import { createVendor } from './vendors';
import { createDeposit, listUndepositedPayments } from './deposits';
import { trialBalance } from './reports';
import { arAging, arAgingDetail } from './reportsExtra';
import { customerBalanceSummary } from './reportsLists';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fuzz-review4');
let db: DB;
let ctx: ServiceContext;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const FAR = d('2099-12-31');

/** GL balance (debit-positive) of an account code, optionally as of a date. */
async function gl(code: string, asOf?: Date): Promise<string> {
  const row = (await trialBalance(ctx, asOf)).rows.find((r) => r.code === code);
  return row ? Money.sub(row.debit, row.credit).toFixed(2) : '0.00';
}

/** Inventory GL 1300 and the inventory valuation report, which must agree. */
async function inventoryTie(): Promise<{ gl: string; valuation: string }> {
  return { gl: await gl('1300'), valuation: (await inventoryValuation(ctx)).grandTotal };
}

/** An inventory item; FIFO when it gets an opening layer through fifo.receiveStock. */
async function stockItem(name: string, fifo: boolean) {
  const it = await createItem(ctx, {
    name,
    type: 'inventory',
    salesPrice: '20.00',
    purchaseCost: '4.00',
    incomeAccountId: acct['4000'],
    expenseAccountId: acct['5000'],
    assetAccountId: acct['1300'],
  });
  if (fifo) await receiveStock(ctx, { itemId: it.id, quantity: 30, unitCost: '4.00', date: d('2025-12-31') });
  else await adjustInventory(ctx, { itemId: it.id, quantityChange: 40, unitCost: '2.50', date: d('2025-12-31') });
  return it.id;
}

async function expectConflict(p: Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).code).toBe('CONFLICT');
  expect((caught as Error).message).toMatch(pattern);
}

/** Customer Balance Summary rows keyed by customer id ('none' = no name). */
async function balanceSummary(): Promise<Map<string, string>> {
  const rep = await customerBalanceSummary(ctx, { asOf: '2099-12-31' } as never);
  const out = new Map<string, string>();
  for (const r of rep.rows) if (r.id !== 'bal:total') out.set(r.id.slice(4), String(r.cells.balance));
  return out;
}

describe('review4 fuzzer findings', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review4-repro@test.local', name: 'R4', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `R4 repro ${seq}`, ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  // ---- 1. FIFO reversals take back the document's own layers ----

  it('FIFO: voiding a bill with a sub-cent unit cost removes the bill own layer', async () => {
    // fuzzer (shrunk): bill (FIFO item line) -> voidBill. Used to take the 3 units from the 4.00
    // opening layer (3.02 / 3 = 1.0067 matched no layer), leaving valuation 111.02 vs GL 120.00.
    const item = await stockItem('Gadget', true); // 30 @ 4.00
    const v = await createVendor(ctx, { displayName: 'Supplier' } as never);
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 3, unitCost: '1.005' }] } as never);
    await voidBill(ctx, bill.id);
    expect(await inventoryTie()).toEqual({ gl: '120.00', valuation: '120.00' });
  });

  it('FIFO: editing a bill twice with sub-cent unit costs keeps valuation = GL', async () => {
    // fuzzer: bill -> editBill -> editBill (the second edit reversed 14 @ 9.8133 from the opening layer)
    const item = await stockItem('Gizmo', true);
    const v = await createVendor(ctx, { displayName: 'Supplier' } as never);
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 6, unitCost: '4.43' }] } as never);
    await updateBill(ctx, bill.id, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 14, unitCost: '9.8133' }] } as never);
    await updateBill(ctx, bill.id, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 9, unitCost: '14.12' }] } as never);
    const tie = await inventoryTie();
    expect(tie.valuation).toBe(tie.gl);
    expect(tie.gl).toBe('247.08'); // 120.00 + 9 x 14.12
  });

  it('FIFO: voiding a bill whose own units were partly sold is refused (no other-cost layer swapped in)', async () => {
    // fuzzer: bill -> fifoConsume (into the bill's layer) -> fifoReceive -> voidBill. Used to take the
    // 10th unit from the later 4.00 layer: 16.00 in the subledger vs 11.00 in the GL.
    const item = await stockItem('Sprocket', true); // 30 @ 4.00
    const v = await createVendor(ctx, { displayName: 'Supplier' } as never);
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 10, unitCost: '9.00' }] } as never);
    await consumeStock(ctx, { itemId: item, quantity: 31, date: d('2026-02-10') }); // 30 @ 4.00 + 1 of the bill's layer
    await receiveStock(ctx, { itemId: item, quantity: 5, unitCost: '4.00', date: d('2026-03-01') });
    await expectConflict(voidBill(ctx, bill.id), /sold or used/);
    expect(await inventoryTie()).toEqual({ gl: '101.00', valuation: '101.00' }); // 9 @ 9.00 + 5 @ 4.00, untouched
  });

  it('FIFO: voiding a credit memo removes the layer its restock created', async () => {
    // fuzzer: bill (FIFO item) -> creditMemo (restock) -> voidCreditMemo (or editCreditMemo). The
    // restock layer is 2 @ 4.7764 (210.16 / 44); the void used to look for 9.55 / 2 = 4.7750 and take
    // the 4.00 opening layer instead: valuation 211.71 vs GL 210.16.
    const item = await stockItem('Widget F', true); // 30 @ 4.00
    const v = await createVendor(ctx, { displayName: 'Supplier' } as never);
    await createBill(ctx, { vendorId: v.id, date: d('2026-01-10'), lines: [{ itemId: item, quantity: 14, unitCost: '6.44' }] } as never);
    const c = await createCustomer(ctx, { displayName: 'Returner' } as never);
    const cm = await createCreditMemo(ctx, { customerId: c.id, date: d('2026-01-25'), lines: [{ itemId: item, quantity: 2, rate: '12.00', restock: true }] } as never);
    await voidCreditMemo(ctx, cm.id);
    expect(await inventoryTie()).toEqual({ gl: '210.16', valuation: '210.16' });
  });

  it('FIFO: a void whose layer is a cent off its posted amount trues the GL up (valuation = GL to the cent)', async () => {
    // fuzzer: ... creditMemo -> valueAdjust -> editCreditMemo. The restock layer (10 @ 4.7764, cost
    // 47.76) is revalued to 4.7769 (47.77 — within rounding of what the memo posted); the void used
    // to take 47.76 off the GL and 47.77 out of the layers.
    const item = await stockItem('Cent F', true); // 30 @ 4.00
    const v = await createVendor(ctx, { displayName: 'Supplier' } as never);
    await createBill(ctx, { vendorId: v.id, date: d('2026-01-10'), lines: [{ itemId: item, quantity: 14, unitCost: '6.44' }] } as never);
    const c = await createCustomer(ctx, { displayName: 'Cent returner' } as never);
    const cm = await createCreditMemo(ctx, { customerId: c.id, date: d('2026-01-25'), lines: [{ itemId: item, quantity: 10, rate: '12.00', restock: true }] } as never);
    await adjustInventoryValue(ctx, { itemId: item, newUnitCost: '4.7769', date: d('2026-02-01') });
    const before = await inventoryTie();
    expect(before.valuation).toBe(before.gl);
    await voidCreditMemo(ctx, cm.id);
    const after = await inventoryTie();
    expect(after.valuation).toBe(after.gl);
  });

  // ---- 2. a void may not take more value off the books than the stock still carries ----

  it('average cost: voiding a bill after a value write-down is refused (no clamp to a $0 average)', async () => {
    // fuzzer: bill -> valueAdjust (write-down) -> voidBill. Used to leave GL 1300 at -70.00 with the
    // item valued 40 @ 0.0000.
    const item = await stockItem('Widget', false); // 40 @ 2.50 = 100.00
    const v = await createVendor(ctx, { displayName: 'Supplier' } as never);
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 10, unitCost: '12.00' }] } as never);
    await adjustInventoryValue(ctx, { itemId: item, newTotalValue: '50.00', date: d('2026-02-15' ) });
    await expectConflict(voidBill(ctx, bill.id), /written down|sold since/);
    expect(await inventoryTie()).toEqual({ gl: '50.00', valuation: '50.00' });
  });

  it('FIFO: voiding a bill (or item receipt) after a value adjustment is refused', async () => {
    // fuzzer: bill -> valueAdjust -> voidBill, itemReceipt -> valueAdjust -> voidItemReceipt. Used to
    // reverse 13.92 in the GL while the bill's units now carried 6.00 each (184.08 vs 180.00).
    const item = await stockItem('Gear', true); // 30 @ 4.00
    const v = await createVendor(ctx, { displayName: 'Supplier' } as never);
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 3, unitCost: '4.64' }] } as never);
    const receipt = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-02-02'), lines: [{ itemId: item, quantity: 2, unitCost: '5.00' }] } as never);
    await adjustInventoryValue(ctx, { itemId: item, newUnitCost: '6.00', date: d('2026-02-15') }); // 35 @ 6.00
    await expectConflict(voidBill(ctx, bill.id), /cost was adjusted/);
    await expectConflict(voidItemReceipt(ctx, receipt.id), /cost was adjusted/);
    expect(await inventoryTie()).toEqual({ gl: '210.00', valuation: '210.00' });
  });

  it('an untouched purchase still voids cleanly (bill and item receipt, FIFO and average)', async () => {
    const fifo = await stockItem('Plain F', true);
    const avg = await stockItem('Plain A', false);
    const v = await createVendor(ctx, { displayName: 'Supplier' } as never);
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: fifo, quantity: 4, unitCost: '3.3333' }, { itemId: avg, quantity: 7, unitCost: '1.0071' }] } as never);
    const receipt = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-02-02'), lines: [{ itemId: fifo, quantity: 2, unitCost: '7.25' }] } as never);
    await voidItemReceipt(ctx, receipt.id);
    await voidBill(ctx, bill.id);
    expect(await inventoryTie()).toEqual({ gl: '220.00', valuation: '220.00' });
  });

  // ---- 3. bounced checks ----

  it('bounced check: the re-charged A/R stays on the customer in name-based reports', async () => {
    // fuzzer: invoice -> receivePayment (deposited straight to Checking) -> bounceCheck. The re-charge
    // used to show under no name (Customer Balance Summary 0.00 for the customer, 100.00 unnamed).
    const c = await createCustomer(ctx, { displayName: 'Bouncer' } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-03-01'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }] } as never);
    const p = await receivePayment(ctx, {
      customerId: c.id,
      date: d('2026-03-05'),
      method: 'check',
      amount: '100.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    } as never);
    await recordBouncedCheck(ctx, { paymentId: p.payment.id, date: d('2026-03-10') });

    const aging = await arAging(ctx, FAR);
    expect(aging.rows.find((r) => r.id === c.id)?.total).toBe('100.00'); // the invoice is open again
    expect(aging.totals.total).toBe(await gl('1200'));
    const bal = await balanceSummary();
    expect(bal.get(c.id) ?? '0.00').toBe('100.00');
    expect(bal.get('none') ?? '0.00').toBe('0.00');
  });

  it('as-of A/R aging before a bounce keeps the bounced payment credit (unapplied part and voided invoices)', async () => {
    // fuzzer: receivePayment (overpaying) -> bounceCheck -> voidInvoice. The bounce zeroed the
    // payment's unapplied credit and deleted its applications undated, so every as-of aging before the
    // bounce lost the credit (and the part applied to an invoice voided after the bounce).
    const c = await createCustomer(ctx, { displayName: 'Bounced prepayer' } as never);
    const a = await createInvoice(ctx, { customerId: c.id, date: d('2026-02-03'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '79.65' }] } as never);
    await createInvoice(ctx, { customerId: c.id, date: d('2026-02-03'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '37.40' }] } as never);
    const p = await receivePayment(ctx, {
      customerId: c.id, date: d('2026-02-18'), method: 'check', amount: '87.50', depositAccountId: acct['1000'],
      applications: [{ invoiceId: a.id, amountApplied: '79.65' }],
    } as never); // 7.85 unapplied
    await recordBouncedCheck(ctx, { paymentId: p.payment.id, date: d('2026-05-02') });
    const asOf = d('2026-03-27');
    expect(await gl('1200', asOf)).toBe('29.55'); // 79.65 + 37.40 - 87.50
    expect((await arAging(ctx, asOf)).totals.total).toBe('29.55');
    await voidInvoice(ctx, a.id); // allowed after the bounce: nothing is applied to it any more
    expect(await gl('1200', asOf)).toBe('-50.10'); // the voided invoice is off A/R at every date
    expect((await arAging(ctx, asOf)).totals.total).toBe('-50.10');
    expect((await arAging(ctx, FAR)).totals.total).toBe(await gl('1200'));
  });

  it('as-of A/R aging before a bounce: an invoice edited down after the bounce shows the excess as the payment credit', async () => {
    // fuzzer: invoice -> receivePayment -> bounceCheck -> editInvoice (down). As of a date between the
    // payment and the bounce, the bounced application (162.99) exceeded the edited invoice (75.34);
    // the 87.65 excess used to vanish from the aging (A/R -144.43 vs aging -56.78).
    const c = await createCustomer(ctx, { displayName: 'Edited down' } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-08-27'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '162.99' }] } as never);
    const p = await receivePayment(ctx, {
      customerId: c.id, date: d('2026-09-05'), method: 'check', amount: '219.77', depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '162.99' }],
    } as never); // 56.78 unapplied
    await recordBouncedCheck(ctx, { paymentId: p.payment.id, date: d('2026-09-27') });
    await updateInvoice(ctx, inv.id, { customerId: c.id, date: d('2026-08-27'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '75.34' }] } as never);

    const asOf = d('2026-09-06');
    expect(await gl('1200', asOf)).toBe('-144.43'); // 75.34 - 219.77
    expect((await arAging(ctx, asOf)).totals.total).toBe('-144.43');
    const detail = await arAgingDetail(ctx, asOf);
    expect(detail.rows.reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero()).toFixed(2)).toBe('-144.43');
    expect((await arAging(ctx, FAR)).totals.total).toBe(await gl('1200')); // 75.34 open again
    expect((await arAging(ctx, FAR)).totals.total).toBe('75.34');
  });

  // ---- 4. / 5. as-of A/R aging ----

  it('as-of A/R aging: a prepayment applied later to a later invoice still counts as a credit before that invoice', async () => {
    // fuzzer: receivePayment (unapplied, before the invoice) -> invoice -> applyPayment. Used to age 0.00.
    const c = await createCustomer(ctx, { displayName: 'Prepayer' } as never);
    const p = await receivePayment(ctx, { customerId: c.id, date: d('2026-03-01'), method: 'check', amount: '100.00', depositAccountId: acct['1000'], applications: [] } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-04-01'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '150.00' }] } as never);
    await applyPayment(ctx, { paymentId: p.payment.id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] });

    const asOf = d('2026-03-15'); // after the prepayment, before the invoice existed
    expect(await gl('1200', asOf)).toBe('-100.00');
    expect((await arAging(ctx, asOf)).totals.total).toBe('-100.00');
    const detail = await arAgingDetail(ctx, asOf);
    expect(detail.rows.reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero()).toFixed(2)).toBe('-100.00');
    // From the invoice date on, the credit is applied.
    expect((await arAging(ctx, d('2026-04-02'))).totals.total).toBe('50.00');
    expect((await arAging(ctx, FAR)).totals.total).toBe('50.00');
  });

  it('as-of A/R aging: a foreign invoice settled on the cutoff and partly unapplied later is not aged as home currency', async () => {
    // fuzzer: invoice (EUR) -> receivePayment (EUR, full) -> unapplyPayment (dated today). Used to age
    // EUR 60 as USD 60.00 on a cutoff where the invoice was fully paid.
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const eurBank = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(ctx, eurBank, 'EUR');
    const c = await createCustomer(ctx, { displayName: 'Euro buyer' } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-03-01'), currency: 'EUR', exchangeRate: '1.30', lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }] } as never);
    const p = await receivePayment(ctx, {
      customerId: c.id, date: d('2026-03-10'), method: 'ach', amount: '100.00', depositAccountId: eurBank,
      currency: 'EUR', exchangeRate: '1.20', applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    } as never);
    await unapplyFromInvoice(ctx, { paymentId: p.payment.id, invoiceId: inv.id, amount: '60.00' }); // dated today

    const asOf = d('2026-03-20'); // the invoice was fully paid then
    expect(await gl('1200', asOf)).toBe('0.00');
    expect((await arAging(ctx, asOf)).totals.total).toBe('0.00');
    const detail = await arAgingDetail(ctx, asOf);
    expect(detail.rows.filter((r) => r.docType === 'invoice')).toHaveLength(0);
    // Today: the invoice owes EUR 60 again and the payment holds EUR 60 of credit — ties to the GL.
    expect((await arAging(ctx, FAR)).totals.total).toBe(await gl('1200'));
  });

  // ---- 8. value remainders (0061) on every average-cost path ----
  // 3000 units for $1000.00: the 4dp average 0.3333 books 999.90, the GL holds 1000.00 — the 0.10
  // is the item's value remainder. Every path must keep GL 1300 = valuation + remainders, and
  // selling out must clear the GL to exactly $0 (the fuzzer found builds / unbuilds, value
  // adjustments, credit-memo restocks and sales voids that lost the cents).

  /** GL 1300 vs inventory valuation + the carried value remainders (stamp = current average). */
  async function exactTie(): Promise<{ gl: string; books: string }> {
    const val = Money.of((await inventoryValuation(ctx)).grandTotal);
    const rows = await db
      .select({ avg: itemsTable.averageCost, rem: itemsTable.valueRemainder, stamp: itemsTable.valueRemainderAvg })
      .from(itemsTable)
      .where(eq(itemsTable.companyId, ctx.companyId));
    const rem = rows
      .filter((r) => r.stamp != null && Money.of(r.stamp).equals(Money.of(r.avg ?? '0')))
      .reduce((s, r) => s.plus(Money.of(r.rem ?? '0')), Money.zero());
    return { gl: await gl('1300'), books: val.plus(rem).toFixed(2) };
  }
  async function thirdsItem(name: string) {
    const it = await createItem(ctx, { name, type: 'inventory', salesPrice: '1.00', incomeAccountId: acct['4000'], expenseAccountId: acct['5000'], assetAccountId: acct['1300'] });
    await adjustInventory(ctx, { itemId: it.id, quantityChange: 3000, unitCost: '0.33333333', date: d('2026-01-02') });
    return it.id;
  }

  it('value remainder: assembly build / unbuild carry the cents, and selling out clears the GL to $0', async () => {
    // fuzzer: build -> check -> unbuild (and adjustQty -> build -> unbuild -> build -> adjustQty -> unbuild)
    const comp = await thirdsItem('Third part');
    const kit = (await createItem(ctx, { name: 'Third kit', type: 'inventory', salesPrice: '1.00', incomeAccountId: acct['4000'], expenseAccountId: acct['5000'], assetAccountId: acct['1300'] })).id;
    await setBom(ctx, kit, [{ componentItemId: comp, quantity: '1' }]);
    expect(await exactTie()).toEqual({ gl: '1000.00', books: '1000.00' });
    await buildAssembly(ctx, { assemblyItemId: kit, quantity: 3000, date: d('2026-01-03') }); // uses every part
    expect(await exactTie()).toEqual({ gl: '1000.00', books: '1000.00' });
    await unbuildAssembly(ctx, { assemblyItemId: kit, quantity: 3000, date: d('2026-01-04') });
    expect(await exactTie()).toEqual({ gl: '1000.00', books: '1000.00' });
    await adjustInventory(ctx, { itemId: comp, quantityChange: -3000, date: d('2026-01-05') });
    expect(await exactTie()).toEqual({ gl: '0.00', books: '0.00' });
  });

  it('value remainder: a value adjustment lands the GL on exactly the value asked for', async () => {
    // fuzzer: itemReceipt -> ... -> valueAdjust (the delta ignored the carried cents: GL 1500.10)
    const item = await thirdsItem('Third revalued');
    await adjustInventoryValue(ctx, { itemId: item, newTotalValue: '1500.00', date: d('2026-01-03') });
    expect(await exactTie()).toEqual({ gl: '1500.00', books: '1500.00' });
    await adjustInventoryValue(ctx, { itemId: item, newTotalValue: '100.00', date: d('2026-01-04') }); // avg 0.0333
    expect(await exactTie()).toEqual({ gl: '100.00', books: '100.00' });
    await adjustInventory(ctx, { itemId: item, quantityChange: -3000, date: d('2026-01-05') });
    expect(await exactTie()).toEqual({ gl: '0.00', books: '0.00' });
  });

  it('value remainder: voiding a sale (invoice or sales receipt) puts the cents back with the stock', async () => {
    // fuzzer: invoice -> check -> bill -> editInvoice; salesReceipt -> voidSalesReceipt
    const item = await thirdsItem('Third sold');
    const c = await createCustomer(ctx, { displayName: 'Third buyer' } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-01-03'), lines: [{ itemId: item, quantity: 3000, rate: '1.00' }] } as never);
    expect(await exactTie()).toEqual({ gl: '0.00', books: '0.00' }); // the sell-out took the 0.10 too
    await voidInvoice(ctx, inv.id);
    expect(await exactTie()).toEqual({ gl: '1000.00', books: '1000.00' });
    const sr = await createSalesReceipt(ctx, { customerId: c.id, date: d('2026-01-04'), depositAccountId: acct['1000'], lines: [{ itemId: item, quantity: 3000, rate: '1.00' }] } as never);
    expect(await exactTie()).toEqual({ gl: '0.00', books: '0.00' });
    await voidSalesReceipt(ctx, sr.id);
    expect(await exactTie()).toEqual({ gl: '1000.00', books: '1000.00' });
    // A restock on a credit memo and its void keep the tie as well.
    const cm = await createCreditMemo(ctx, { customerId: c.id, date: d('2026-01-05'), lines: [{ itemId: item, quantity: 7, rate: '1.00', restock: true }] } as never);
    expect((await exactTie()).books).toBe((await exactTie()).gl);
    await voidCreditMemo(ctx, cm.id);
    expect(await exactTie()).toEqual({ gl: '1000.00', books: '1000.00' });
    await adjustInventory(ctx, { itemId: item, quantityChange: -3000, date: d('2026-01-06') });
    expect(await exactTie()).toEqual({ gl: '0.00', books: '0.00' });
  });

  // ---- 6. deposits ----

  it('deposit: a deposit cannot be dated before the payments in it', async () => {
    // fuzzer: receivePayment (to Undeposited Funds) -> deposit dated before the payment. Used to leave
    // Undeposited Funds at -100.00 as of 03-07 while the as-of deposit picker held nothing.
    const c = await createCustomer(ctx, { displayName: 'Payer' } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-03-01'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }] } as never);
    const p = await receivePayment(ctx, { customerId: c.id, date: d('2026-03-10'), method: 'check', amount: '100.00', applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] } as never);
    let caught: unknown;
    try {
      await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-03-05'), paymentIds: [p.payment.id] });
    } catch (err) {
      caught = err;
    }
    expect((caught as ServiceError)?.code).toBe('VALIDATION');
    expect(String((caught as Error)?.message)).toMatch(/before the payment/);
    // Same day and later are fine; the picker and the GL agree at every date.
    await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-03-10'), paymentIds: [p.payment.id] });
    for (const day of ['2026-03-07', '2026-03-10', '2026-03-12']) {
      const picker = await listUndepositedPayments(ctx, { asOf: new Date(`${day}T23:59:59.999Z`) });
      const total = picker.reduce((s, x) => s.plus(Money.of(x.amount)), Money.zero()).toFixed(2);
      expect(await gl('1050', d(day))).toBe(total);
    }
  });
});
