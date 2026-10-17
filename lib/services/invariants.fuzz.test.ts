/**
 * Review round 4 — seeded, deterministic, randomized cross-module INVARIANT FUZZER.
 *
 * One PGlite database (.bookkeeper-data/test-invariants-fuzz); every seed gets its own company with
 * customers / vendors (one of each in EUR), tax rates, average-cost and FIFO inventory items, an
 * assembly with a BOM, discount / subtotal / payment items and two inventory sites. A seeded PRNG
 * (mulberry32) then drives N random operations through the PUBLIC services:
 *
 *   sales      invoices (inventory / service / discount / subtotal / payment lines, header
 *              discounts, tax, retainage, drafts, EUR), edits, voids, sales receipts, credit
 *              memos (apply, unapply, refund, edit, void), receive payments (partial, overpay,
 *              early-payment discount, credits, EUR), apply / unapply / refund / edit / void /
 *              bounce payments, deposits (incl. invoice payment lines, extra lines, cash back),
 *              deposit edits / removals / voids
 *   purchases  bills (expense + inventory lines, EUR), edits, voids, bill payments (partial,
 *              discount, credit card, EUR at another rate, vendor credits), edits / voids,
 *              vendor credits (apply, unapply, refund, edit, void), checks / card charges,
 *              item receipts (-> bills, edits, voids), purchase orders (-> partial bills)
 *   inventory  quantity adjustments, value adjustments, physical counts, FIFO receive/consume,
 *              site transfers (and voids), assembly builds / unbuilds
 *   banking    transfers (home and EUR), edits, voids; journal entries (expense, named A/R and
 *              A/P lines), edits, reversals, voids
 *
 * Each operation draws its inputs from its OWN PRNG (seeded from the run seed and the step), so a
 * failing run can be replayed — and shrunk — as a list of `op@seed` steps.
 *
 * Expected refusals (ServiceError VALIDATION / CONFLICT / NOT_FOUND / PERIOD_CLOSED) are fine.
 * Anything else (TypeError, a DB error, INTERNAL / UNBALANCED, a ledger SQLSTATE) is a bug.
 *
 * Dependent documents are dated on/after what they depend on (a payment after its invoices, a
 * deposit after its payments, a refund after the last application of its credit, ...), so the
 * as-of invariants test reconstruction, not impossible histories.
 *
 * Every K operations and at the end, the cross-module invariants are asserted (checkInvariants;
 * the [id] tags are what FUZZ_SOFT takes):
 *   [books] [integrity]       booksInBalance (trial balance, accrual + cash-basis balance sheets,
 *                             cached balances, guards) and every verifyIntegrity check
 *   [ar-aging] [ar-name] [ar-docs]  GL 1200 = A/R aging total; aging per customer = Customer
 *                             Balance Summary; = open invoices - unapplied memos - unapplied payments
 *   [ap-aging] [ap-name] [ap-docs]  the same for GL 2000 / A/P aging / Vendor Balance Summary / bills
 *   [uf]                      GL 1050 = the deposit picker (listUndepositedPayments)
 *   [accrual]                 item-receipt accrual (2050) = open item receipts
 *   [inv-gl] [inv-item] [fifo-qty] [inv-neg] [site]  GL 1300 = inventory valuation (per item vs
 *                             GL-attributed value), FIFO layers = quantity on hand, no negative stock
 *                             or layers, no negative non-default site. Exact to the cent: GL 1300 =
 *                             valuation + the average-cost value remainders (migration 0061)
 *   [inv-bounds] [bill-bounds] [cm-bounds] [cm-apps] [vc-bounds] [pay-bounds] [inv-paid]
 *                             0 <= balanceDue <= total and = total - paid (- retainage / credited),
 *                             status paid <=> 0 due, credits in [0, total], applications add up
 *   [doc-header] [doc-gl] [sales-tax]  invoice total = subtotal - discount + tax; the control-account
 *                             posting of each live document = its total; GL 2200 = tax on documents
 *   [pl-bs] [pl-split]        P&L net income = balance-sheet earnings (whole window and at a random
 *                             cutoff D); P&L(..D) + P&L(D+1..) = P&L(whole)
 *   [ar-asof] [ap-asof] [uf-asof]  A/R aging, A/P aging and the deposit picker as of D = GL as of D
 *
 * Env:
 *   FUZZ_SEEDS   "1,2,3" or "1-30"     (default "4101-4104")
 *   FUZZ_OPS     operations per seed   (default 200)
 *   FUZZ_CHECK   check every K ops     (default 30)
 *   FUZZ_REPLAY  "op@seed op@seed ..." replay exactly these steps (one company)
 *   FUZZ_MIN     "1" = on failure, delta-debug the failing sequence to a minimal one
 *   FUZZ_DUMP    "1" = with FUZZ_REPLAY, print the company's documents, layers and entries
 *   FUZZ_EXCLUDE comma list of operations to leave out of generated runs
 *   FUZZ_WHOLE_CENTS "1" = purchase unit costs in whole cents only
 *   FUZZ_DIR     data directory under .bookkeeper-data (default test-invariants-fuzz)
 *   FUZZ_DEBUG / FUZZ_STATS  log every step / per-op success and refusal counts
 *   FUZZ_SOFT    comma list of invariant ids that only warn (default: none — all hard)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, customers, users, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { setAccountCurrency, setBaseCurrency, upsertCurrency } from './currencies';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createItem } from './items';
import { createTaxAgency, createTaxRate } from './salesTax';
import { createInvoice, postDraftInvoice, updateInvoice, voidInvoice } from './invoices';
import { createSalesReceipt, updateSalesReceipt, voidSalesReceipt } from './salesReceipts';
import {
  applyToInvoice,
  createCreditMemo,
  refundCreditMemo,
  unapplyCreditApplication,
  updateCreditMemo,
  voidCreditMemo,
} from './creditMemos';
import {
  applyPayment,
  receivePayment,
  recordBouncedCheck,
  refundPayment,
  unapplyFromInvoice,
  updatePayment,
  voidPayment,
} from './payments';
import {
  createDeposit,
  getDeposit,
  listUndepositedPayments,
  removePaymentFromDeposit,
  updateDeposit,
  voidDeposit,
} from './deposits';
import { createBill, updateBill, voidBill } from './bills';
import { payBills, payBillsWithCredits, updateBillPayment, voidBillPayment } from './billPayments';
import {
  applyToBill,
  createVendorCredit,
  refundVendorCredit,
  unapplyFromBill,
  updateVendorCredit,
  voidVendorCredit,
} from './vendorCredits';
import { createExpense, updateExpense, voidExpense } from './expenses';
import {
  convertToBill as convertReceiptToBill,
  createItemReceipt,
  updateItemReceipt,
  voidItemReceipt,
} from './itemReceipts';
import { convertToBill as convertPoToBill, createPurchaseOrder, getPurchaseOrder } from './purchaseOrders';
import { adjustInventory, inventoryValuation, inventoryValuationAsOf } from './inventory';
import { adjustInventoryValue, physicalCount } from './inventoryOps';
import { consumeStock, receiveStock } from './fifo';
import { createSite, ensureDefaultSite, siteQuantities } from './inventorySites';
import { createInventoryTransfer, voidInventoryTransfer } from './inventoryTransfers';
import { buildAssembly, setBom, unbuildAssembly } from './assemblies';
import { createTransfer, updateTransfer, voidTransfer } from './transfers';
import { createManualEntry, reverseEntry, updateEntry, voidEntry } from './journal';
import { balanceSheet, profitAndLoss, trialBalance } from './reports';
import { apAging, arAging } from './reportsExtra';
import { customerBalanceSummary, vendorBalanceSummary } from './reportsLists';
import { booksInBalance, verifyIntegrity } from './integrity';

export const FUZZ_DIR = path.resolve(process.cwd(), '.bookkeeper-data', process.env.FUZZ_DIR ?? 'test-invariants-fuzz');

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** mulberry32: tiny, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mixSeed(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export class R {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  f(): number {
    return this.next();
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T | undefined {
    return xs.length ? xs[Math.floor(this.next() * xs.length)] : undefined;
  }
  money(lo: number, hi: number): string {
    return toAmountString((lo * 100 + this.int(0, Math.round((hi - lo) * 100))) / 100);
  }
  rate(): string {
    return (1.05 + this.int(0, 3000) / 10000).toFixed(4);
  }
  /** A date in the 2026-01-01 .. 2026-09-30 window (noon UTC; sometimes midnight). */
  day(): Date {
    return new Date(Date.UTC(2026, 0, 1 + this.int(0, 272), this.chance(0.1) ? 0 : 12));
  }
  /**
   * A date on/after every given date (a payment after the invoices it pays, a deposit after the
   * payments in it, ...): up to 90 days later, kept inside the window when possible.
   */
  dayFrom(...dates: Array<Date | string | null | undefined>): Date {
    const ts = dates.filter((d): d is Date | string => d != null).map((d) => new Date(d).getTime());
    if (!ts.length) return this.day();
    const base = new Date(Math.max(...ts));
    const day0 = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
    const end = Date.UTC(2026, 8, 30);
    const span = Math.max(0, Math.min(90, Math.floor((end - day0) / 86_400_000)));
    const hour = base.getUTCHours() > 12 ? base.getUTCHours() : 12;
    return new Date(day0 + this.int(0, span) * 86_400_000 + hour * 3_600_000);
  }
  frac(): string {
    return (0.1 + this.int(0, 80) / 100).toFixed(2);
  }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface World {
  db: DB;
  ctx: ServiceContext;
  acct: Record<string, string>;
  cust: string[];
  eurCust: string;
  vend: string[];
  eurVend: string;
  tax: string[];
  item: {
    avg: string[];
    fifo: string[];
    comps: string[];
    kit: string;
    service: string;
    nonInv: string;
    charge: string;
    discount: string;
    subtotal: string;
    payment: string;
  };
  sites: { main: string; annex: string };
  docs: Record<string, string[]>;
  order: Map<string, number>;
  /** Latest dated activity (application, unapply, refund) per document — later activity is dated on/after it. */
  lastAct: Map<string, Date>;
}

const DOC_KINDS = [
  'inv', 'sr', 'cm', 'pay', 'dep', 'bill', 'bp', 'vc', 'chk', 'ir', 'po', 'xfer', 'je', 'itx',
] as const;

let worldSeq = 0;

export async function setupWorld(db: DB, userId: string, tag: string): Promise<World> {
  worldSeq += 1;
  const company = await createCompany(db, { name: `Fuzz ${tag} #${worldSeq}`, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;

  await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
  acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
  await setAccountCurrency(ctx, acct['1020'], 'EUR');

  const cust: string[] = [];
  for (let i = 0; i < 4; i++) cust.push((await createCustomer(ctx, { displayName: `Cust ${i}` } as never)).id);
  const eurCust = (await createCustomer(ctx, { displayName: 'Cust EUR' } as never)).id;
  const vend: string[] = [];
  for (let i = 0; i < 3; i++) vend.push((await createVendor(ctx, { displayName: `Vend ${i}` } as never)).id);
  const eurVend = (await createVendor(ctx, { displayName: 'Vend EUR' } as never)).id;
  await db.update(vendors).set({ currency: 'EUR' }).where(eq(vendors.id, eurVend));
  void customers;

  const agency = await createTaxAgency(ctx, { name: 'State DOR', liabilityAccountId: acct['2200'] });
  const tax = [
    (await createTaxRate(ctx, { name: 'State 8.25%', rate: '0.0825', agencyId: agency.id })).id,
    (await createTaxRate(ctx, { name: 'City 2.5%', rate: '0.025', agencyId: agency.id })).id,
  ];

  const inv = (name: string, price: string, cost: string) =>
    createItem(ctx, {
      name,
      type: 'inventory',
      salesPrice: price,
      purchaseCost: cost,
      incomeAccountId: acct['4000'],
      expenseAccountId: acct['5000'],
      assetAccountId: acct['1300'],
      taxable: true,
    }).then((x) => x.id);
  const avg = [await inv('Widget A', '19.99', '8.13'), await inv('Widget B', '7.35', '2.71')];
  const fifo = [await inv('Gadget F', '24.50', '9.40'), await inv('Gizmo F', '11.00', '3.33')];
  const comps = [await inv('Part C1', '3.00', '1.17'), await inv('Part C2', '5.00', '2.09')];
  const kit = await inv('Kit K', '45.00', '0');
  await setBom(ctx, kit, [
    { componentItemId: comps[0], quantity: '2' },
    { componentItemId: comps[1], quantity: '1' },
  ]);
  const service = (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: '125.00', incomeAccountId: acct['4100'], taxable: false })).id;
  const nonInv = (await createItem(ctx, { name: 'Supplies', type: 'non_inventory', salesPrice: '12.00', purchaseCost: '6.00', incomeAccountId: acct['4000'], expenseAccountId: acct['6300'], taxable: true })).id;
  const charge = (await createItem(ctx, { name: 'Shipping', type: 'other_charge', salesPrice: '9.95', incomeAccountId: acct['4900'], taxable: false })).id;
  const discount = (await createItem(ctx, { name: 'Promo Disc', type: 'discount', salesPrice: '5.00', incomeAccountId: acct['4000'], taxable: true })).id;
  const subtotal = (await createItem(ctx, { name: 'Subtotal', type: 'subtotal' })).id;
  const payment = (await createItem(ctx, { name: 'Deposit Rcvd', type: 'payment' })).id;

  const main = (await ensureDefaultSite(ctx)).id;
  const annex = (await createSite(ctx, { name: 'Annex' })).id;

  const w: World = {
    db,
    ctx,
    acct,
    cust,
    eurCust,
    vend,
    eurVend,
    tax,
    item: { avg, fifo, comps, kit, service, nonInv, charge, discount, subtotal, payment },
    sites: { main, annex },
    docs: Object.fromEntries(DOC_KINDS.map((k) => [k, [] as string[]])),
    order: new Map(),
    lastAct: new Map(),
  };

  // Opening stock: average items via adjustments, FIFO items via layers (makes them FIFO).
  const open = new Date(Date.UTC(2025, 11, 31, 12));
  for (const id of [...avg, ...comps]) {
    await adjustInventory(ctx, { itemId: id, quantityChange: 40, unitCost: '2.50', date: open });
  }
  for (const id of fifo) await receiveStock(ctx, { itemId: id, quantity: 30, unitCost: '4.00', date: open });
  return w;
}

/** Dates of the latest activity on these documents. */
function lastOf(w: World, ...ids: Array<string | null | undefined>): Date[] {
  return ids.map((i) => (i ? w.lastAct.get(i) : undefined)).filter((d): d is Date => !!d);
}

/** Record dated activity on documents (undated service calls happen "now"). */
function touch(w: World, d: Date | string | null | undefined, ...ids: Array<string | null | undefined>) {
  const at = d ? new Date(d) : new Date();
  for (const i of ids) if (i && !(w.lastAct.get(i) && w.lastAct.get(i)! > at)) w.lastAct.set(i, at);
}

function track(w: World, kind: string, id: string | undefined | null) {
  if (!id) return;
  w.docs[kind].push(id);
  w.order.set(id, w.order.size);
}

async function rows<T = Record<string, unknown>>(w: World, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await w.db.execute(q)).rows as T[];
}

/** Ids from `kind` (in creation order) passing a SQL filter. */
async function liveDocs(w: World, kind: string, table: string, where: ReturnType<typeof sql>): Promise<string[]> {
  const ids = w.docs[kind];
  if (!ids.length) return [];
  const found = await rows<{ id: string }>(
    w,
    sql`SELECT id FROM ${sql.identifier(table)} WHERE company_id = ${w.ctx.companyId} AND id IN (${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )}) AND ${where}`,
  );
  const set = new Set(found.map((f) => f.id));
  return ids.filter((i) => set.has(i));
}

async function one<T = Record<string, unknown>>(w: World, q: ReturnType<typeof sql>): Promise<T | undefined> {
  return (await rows<T>(w, q))[0];
}

function sortByOrder<T extends { id: string }>(w: World, xs: T[]): T[] {
  return [...xs].sort((a, b) => (w.order.get(a.id) ?? 1e9) - (w.order.get(b.id) ?? 1e9) || a.id.localeCompare(b.id));
}

/** Open invoices of a customer (creation order) with their balance due. */
async function openInvoicesOf(w: World, customerId: string, currency: 'EUR' | null) {
  const all = await rows<{ id: string; balance_due: string; currency: string | null; date: Date }>(
    w,
    sql`SELECT id, balance_due, currency, date FROM invoices WHERE company_id = ${w.ctx.companyId} AND customer_id = ${customerId}
        AND status IN ('open','partial','overdue') AND CAST(balance_due AS NUMERIC) > 0`,
  );
  return sortByOrder(w, all).filter((r) => (r.currency ?? null) === currency);
}

async function openBillsOf(w: World, vendorId: string) {
  const all = await rows<{ id: string; balance_due: string; currency: string | null; date: Date }>(
    w,
    sql`SELECT id, balance_due, currency, date FROM bills WHERE company_id = ${w.ctx.companyId} AND vendor_id = ${vendorId}
        AND status <> 'void' AND CAST(balance_due AS NUMERIC) > 0`,
  );
  return sortByOrder(w, all);
}

const min = (a: string, b: string) => (Money.of(a).lessThan(Money.of(b)) ? a : b);
const part = (r: R, amount: string) => {
  const roll = r.f();
  if (roll < 0.45) return toAmountString(amount);
  const p = Money.round2(Money.mul(amount, r.frac()));
  return p.greaterThan(0) ? toAmountString(p) : toAmountString(amount);
};

// ---------------------------------------------------------------------------
// Line builders
// ---------------------------------------------------------------------------

function salesLines(w: World, r: R, opts: { eur?: boolean; payments?: boolean; receipt?: boolean } = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const n = r.int(1, 4);
  for (let i = 0; i < n; i++) {
    const kind = opts.eur
      ? r.pick(['service', 'nonInv', 'charge', 'account'] as const)!
      : r.pick(['avg', 'avg', 'fifo', 'service', 'nonInv', 'charge', 'kit', 'account'] as const)!;
    const qty = r.int(1, 5);
    const rate = r.chance(0.85) ? r.money(5, 60) : undefined;
    const taxable = r.chance(0.6);
    switch (kind) {
      case 'avg':
        lines.push({ itemId: r.pick(w.item.avg), quantity: qty, rate, taxable });
        break;
      case 'fifo':
        lines.push({ itemId: r.pick(w.item.fifo), quantity: qty, rate, taxable });
        break;
      case 'kit':
        lines.push({ itemId: w.item.kit, quantity: r.int(1, 2), rate: rate ?? '45.00', taxable });
        break;
      case 'account':
        lines.push({ accountId: r.pick([w.acct['4000'], w.acct['4100'], w.acct['4900']]), description: 'Misc', quantity: 1, rate: r.money(5, 200), taxable });
        break;
      default:
        lines.push({ itemId: w.item[kind], quantity: qty, rate, taxable });
    }
    if (r.chance(0.12)) lines.push({ itemId: w.item.subtotal, quantity: 1 });
  }
  if (r.chance(0.15)) lines.push({ itemId: w.item.discount, quantity: 1, rate: r.money(1, 8), taxable: r.chance(0.5) });
  if (opts.payments && r.chance(0.12)) lines.push({ itemId: w.item.payment, quantity: 1, rate: r.money(1, 15) });
  return lines;
}

function purchaseLines(w: World, r: R, opts: { eur?: boolean; inventoryOnly?: boolean } = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const n = r.int(1, 3);
  for (let i = 0; i < n; i++) {
    if (!opts.inventoryOnly && r.chance(0.45)) {
      lines.push({ accountId: r.pick([w.acct['6200'], w.acct['6300'], w.acct['6400'], w.acct['6600']]), amount: r.money(5, 400) });
    } else {
      const itemId = r.pick([...w.item.avg, ...w.item.fifo, ...w.item.comps])!;
      // Unit costs are usually whole cents; sometimes 3-4 decimals (QB keeps up to 5 on costs).
      const frac = r.chance(0.2) && !process.env.FUZZ_WHOLE_CENTS;
      const unitCost = frac ? (1 + r.int(0, 140000) / 10000).toFixed(r.chance(0.5) ? 3 : 4) : r.money(1, 15);
      lines.push({ itemId, quantity: r.int(1, 15), unitCost });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type Op = (w: World, r: R) => Promise<unknown>;

const SKIP = 'skip';

async function pickLive(w: World, r: R, kind: string, table: string, where = sql`true`) {
  return r.pick(await liveDocs(w, kind, table, where));
}

const OPS: Record<string, [number, Op]> = {
  // ---------------- sales ----------------
  invoice: [14, async (w, r) => {
    const eur = r.chance(0.12);
    const headerDisc = r.chance(0.2);
    const pct = r.chance(0.4);
    const inv = await createInvoice(w.ctx, {
      customerId: eur ? w.eurCust : r.pick(w.cust)!,
      date: r.day(),
      lines: salesLines(w, r, { eur, payments: true }),
      taxRateId: r.chance(0.5) ? r.pick(w.tax) : null,
      discount: headerDisc ? (pct ? r.int(1, 15) : r.money(1, 10)) : null,
      discountType: headerDisc && pct ? 'percent' : 'amount',
      retainagePercent: r.chance(0.05) ? r.int(5, 10) : null,
      status: r.chance(0.08) ? 'draft' : 'open',
      ...(eur ? { currency: 'EUR', exchangeRate: r.rate() } : {}),
    } as never);
    track(w, 'inv', inv.id);
  }],
  postDraft: [2, async (w, r) => {
    const id = await pickLive(w, r, 'inv', 'invoices', sql`status = 'draft'`);
    if (!id) return SKIP;
    await postDraftInvoice(w.ctx, id);
  }],
  editInvoice: [4, async (w, r) => {
    const id = await pickLive(w, r, 'inv', 'invoices', sql`status <> 'void'`);
    if (!id) return SKIP;
    const cur = (await one<{ customer_id: string; currency: string | null; exchange_rate: string | null; date: Date; amount_paid: string }>(
      w, sql`SELECT customer_id, currency, exchange_rate, date, amount_paid FROM invoices WHERE id = ${id}`))!;
    const eur = !!cur.currency;
    await updateInvoice(w.ctx, id, {
      customerId: cur.customer_id,
      date: Money.isZero(cur.amount_paid) && r.chance(0.4) ? r.day() : new Date(cur.date),
      lines: salesLines(w, r, { eur, payments: true }),
      taxRateId: r.chance(0.5) ? r.pick(w.tax) : null,
      discount: r.chance(0.2) ? r.money(1, 10) : null,
      ...(eur ? { currency: cur.currency, exchangeRate: cur.exchange_rate } : {}),
    } as never);
  }],
  voidInvoice: [2, async (w, r) => {
    const id = await pickLive(w, r, 'inv', 'invoices', sql`status <> 'void'`);
    if (!id) return SKIP;
    await voidInvoice(w.ctx, id);
  }],
  salesReceipt: [5, async (w, r) => {
    const sr = await createSalesReceipt(w.ctx, {
      customerId: r.chance(0.8) ? r.pick(w.cust) : null,
      date: r.day(),
      lines: salesLines(w, r, { receipt: true }),
      taxRateId: r.chance(0.5) ? r.pick(w.tax) : null,
      depositAccountId: r.chance(0.6) ? null : w.acct['1000'],
      method: r.pick(['cash', 'check', 'credit_card'] as const),
    } as never);
    track(w, 'sr', sr.id);
  }],
  editSalesReceipt: [2, async (w, r) => {
    const id = await pickLive(w, r, 'sr', 'sales_receipts', sql`status <> 'void'`);
    if (!id) return SKIP;
    const cur = (await one<{ customer_id: string | null; deposit_account_id: string | null; date: Date }>(
      w, sql`SELECT customer_id, deposit_account_id, date FROM sales_receipts WHERE id = ${id}`))!;
    await updateSalesReceipt(w.ctx, id, {
      customerId: cur.customer_id,
      date: new Date(cur.date),
      lines: salesLines(w, r, { receipt: true }),
      taxRateId: r.chance(0.5) ? r.pick(w.tax) : null,
      depositAccountId: r.chance(0.7) ? cur.deposit_account_id : r.chance(0.5) ? w.acct['1000'] : null,
    } as never);
  }],
  voidSalesReceipt: [1, async (w, r) => {
    const id = await pickLive(w, r, 'sr', 'sales_receipts', sql`status <> 'void'`);
    if (!id) return SKIP;
    await voidSalesReceipt(w.ctx, id);
  }],
  creditMemo: [5, async (w, r) => {
    const lines = [];
    for (let i = r.int(1, 2); i > 0; i--) {
      lines.push(
        r.chance(0.5)
          ? { itemId: r.pick([...w.item.avg, ...w.item.fifo]), quantity: r.int(1, 3), rate: r.money(5, 30), restock: r.chance(0.6), taxable: r.chance(0.5) }
          : { itemId: w.item.service, quantity: 1, rate: r.money(5, 80), taxable: false },
      );
    }
    const cm = await createCreditMemo(w.ctx, {
      customerId: r.pick(w.cust)!,
      date: r.day(),
      lines,
      taxRateId: r.chance(0.4) ? r.pick(w.tax) : null,
    } as never);
    track(w, 'cm', cm.id);
  }],
  applyCreditMemo: [5, async (w, r) => {
    const id = await pickLive(w, r, 'cm', 'credit_memos', sql`status <> 'void' AND CAST(unapplied AS NUMERIC) > 0`);
    if (!id) return SKIP;
    const cm = (await one<{ customer_id: string; unapplied: string; date: Date }>(w, sql`SELECT customer_id, unapplied, date FROM credit_memos WHERE id = ${id}`))!;
    const inv = r.pick(await openInvoicesOf(w, cm.customer_id, null));
    if (!inv) return SKIP;
    let applyAt: Date | undefined;
    await applyToInvoice(w.ctx, {
      creditMemoId: id,
      invoiceId: inv.id,
      amount: part(r, min(cm.unapplied, inv.balance_due)),
      date: (applyAt = r.chance(0.3) || lastOf(w, id, inv.id).length ? r.dayFrom(cm.date, inv.date, ...lastOf(w, id, inv.id)) : undefined),
    });
    touch(w, applyAt ?? new Date(Math.max(new Date(cm.date).getTime(), new Date(inv.date).getTime())), id, inv.id);
  }],
  unapplyCredit: [2, async (w, r) => {
    const ids = w.docs.cm;
    if (!ids.length) return SKIP;
    const apps = await rows<{ id: string; credit_memo_id: string; invoice_id: string }>(
      w, sql`SELECT id, credit_memo_id, invoice_id FROM credit_applications WHERE company_id = ${w.ctx.companyId} ORDER BY created_at, amount`);
    const a = r.pick(apps);
    if (!a) return SKIP;
    await unapplyCreditApplication(w.ctx, a.id);
    touch(w, null, a.credit_memo_id, a.invoice_id);
  }],
  refundCreditMemo: [2, async (w, r) => {
    const id = await pickLive(w, r, 'cm', 'credit_memos', sql`status <> 'void' AND CAST(unapplied AS NUMERIC) > 0`);
    if (!id) return SKIP;
    const cm = (await one<{ unapplied: string; date: Date }>(w, sql`SELECT unapplied, date FROM credit_memos WHERE id = ${id}`))!;
    let at: Date;
    await refundCreditMemo(w.ctx, { creditMemoId: id, bankAccountId: w.acct['1000'], amount: part(r, cm.unapplied), date: (at = r.dayFrom(cm.date, ...lastOf(w, id))) });
    touch(w, at, id);
  }],
  editCreditMemo: [2, async (w, r) => {
    const id = await pickLive(w, r, 'cm', 'credit_memos', sql`status <> 'void'`);
    if (!id) return SKIP;
    const cm = (await one<{ customer_id: string; date: Date; unapplied: string; total: string }>(w, sql`SELECT customer_id, date, unapplied, total FROM credit_memos WHERE id = ${id}`))!;
    await updateCreditMemo(w.ctx, id, {
      customerId: cm.customer_id,
      date: Money.eq(cm.unapplied, cm.total) && r.chance(0.4) ? r.day() : new Date(cm.date),
      lines: [
        r.chance(0.5)
          ? { itemId: r.pick(w.item.avg), quantity: r.int(1, 3), rate: r.money(5, 30), restock: r.chance(0.6) }
          : { itemId: w.item.service, quantity: 1, rate: r.money(5, 80), taxable: false },
      ],
      taxRateId: r.chance(0.4) ? r.pick(w.tax) : null,
    } as never);
  }],
  voidCreditMemo: [1, async (w, r) => {
    const id = await pickLive(w, r, 'cm', 'credit_memos', sql`status <> 'void'`);
    if (!id) return SKIP;
    await voidCreditMemo(w.ctx, id);
  }],
  receivePayment: [14, async (w, r) => {
    const eur = r.chance(0.12);
    const customerId = eur ? w.eurCust : r.pick(w.cust)!;
    const open = await openInvoicesOf(w, customerId, eur ? 'EUR' : null);
    const prepay = r.chance(0.05);
    if (!open.length && !prepay) return SKIP;
    const chosen = prepay ? [] : open.filter(() => r.chance(0.6));
    if (!chosen.length && open.length && !prepay) chosen.push(open[0]);
    const applications = chosen.map((inv) => {
      const applied = part(r, inv.balance_due);
      const disc = !eur && r.chance(0.1) ? Money.round2(Money.mul(Money.sub(inv.balance_due, applied), '0.5')) : Money.zero();
      return { invoiceId: inv.id, amountApplied: applied, ...(disc.greaterThan(0) ? { discountAmount: toAmountString(disc) } : {}) };
    });
    // Credits with the payment (home only).
    let credits: Array<{ creditMemoId: string; invoiceId: string; amount: string }> | undefined;
    let memoDate: Date | undefined;
    if (!eur && applications.length && r.chance(0.15)) {
      const memo = await one<{ id: string; unapplied: string; date: Date }>(
        w, sql`SELECT id, unapplied, date FROM credit_memos WHERE company_id = ${w.ctx.companyId} AND customer_id = ${customerId}
               AND status <> 'void' AND CAST(unapplied AS NUMERIC) > 0 ORDER BY date, memo_number LIMIT 1`);
      const a = applications[0];
      const inv = chosen[0];
      const left = Money.sub(Money.sub(inv.balance_due, a.amountApplied), a.discountAmount ?? 0);
      if (memo && left.greaterThan(0)) {
        credits = [{ creditMemoId: memo.id, invoiceId: inv.id, amount: part(r, min(memo.unapplied, toAmountString(left))) }];
        memoDate = [new Date(memo.date), ...lastOf(w, memo.id)].sort((a, b) => b.getTime() - a.getTime())[0];
      }
    }
    const sumApplied = applications.reduce((s, a) => s.plus(Money.of(a.amountApplied)), Money.zero());
    const over = prepay || r.chance(0.15) ? Money.of(r.money(1, 60)) : Money.zero();
    const p = await receivePayment(w.ctx, {
      customerId,
      date: chosen.length ? r.dayFrom(...chosen.map((c) => c.date), ...lastOf(w, ...chosen.map((c) => c.id)), memoDate) : r.day(),
      method: r.pick(['check', 'cash', 'ach'] as const)!,
      amount: toAmountString(sumApplied.plus(over)),
      depositAccountId: eur ? (r.chance(0.8) ? w.acct['1020'] : null) : r.chance(0.6) ? null : w.acct['1000'],
      applications,
      credits,
      ...(eur ? { currency: 'EUR', exchangeRate: r.rate() } : {}),
    } as never);
    track(w, 'pay', p.payment.id);
  }],
  applyPayment: [3, async (w, r) => {
    const id = await pickLive(w, r, 'pay', 'payments_received', sql`voided_at IS NULL AND CAST(unapplied AS NUMERIC) > 0`);
    if (!id) return SKIP;
    const p = (await one<{ customer_id: string; unapplied: string; currency: string | null }>(
      w, sql`SELECT customer_id, unapplied, currency FROM payments_received WHERE id = ${id}`))!;
    const inv = r.pick(await openInvoicesOf(w, p.customer_id, (p.currency as 'EUR' | null) ?? null));
    if (!inv) return SKIP;
    await applyPayment(w.ctx, { paymentId: id, applications: [{ invoiceId: inv.id, amountApplied: part(r, min(p.unapplied, inv.balance_due)) }] });
  }],
  unapplyPayment: [2, async (w, r) => {
    const live = await liveDocs(w, 'pay', 'payments_received', sql`voided_at IS NULL`);
    if (!live.length) return SKIP;
    const apps = await rows<{ payment_id: string; invoice_id: string; amount_applied: string }>(
      w, sql`SELECT payment_id, invoice_id, amount_applied FROM payment_applications WHERE payment_id IN (${sql.join(live.map((i) => sql`${i}`), sql`, `)})`);
    const sorted = apps.sort((a, b) => (w.order.get(a.payment_id)! - w.order.get(b.payment_id)!) || (w.order.get(a.invoice_id) ?? 0) - (w.order.get(b.invoice_id) ?? 0));
    const a = r.pick(sorted);
    if (!a || !Money.of(a.amount_applied).greaterThan(0)) return SKIP;
    await unapplyFromInvoice(w.ctx, { paymentId: a.payment_id, invoiceId: a.invoice_id, amount: r.chance(0.5) ? null : part(r, a.amount_applied) });
    touch(w, null, a.payment_id, a.invoice_id);
  }],
  refundPayment: [2, async (w, r) => {
    const id = await pickLive(w, r, 'pay', 'payments_received', sql`voided_at IS NULL AND CAST(unapplied AS NUMERIC) > 0`);
    if (!id) return SKIP;
    const p = (await one<{ unapplied: string; currency: string | null; date: Date }>(w, sql`SELECT unapplied, currency, date FROM payments_received WHERE id = ${id}`))!;
    let at: Date;
    await refundPayment(w.ctx, { paymentId: id, bankAccountId: p.currency ? w.acct['1020'] : w.acct['1000'], amount: part(r, p.unapplied), date: (at = r.dayFrom(p.date, ...lastOf(w, id))) });
    touch(w, at, id);
  }],
  editPayment: [3, async (w, r) => {
    const id = await pickLive(w, r, 'pay', 'payments_received', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    const p = (await one<{ customer_id: string; amount: string; currency: string | null; exchange_rate: string | null; deposit_account_id: string; date: Date; method: string }>(
      w, sql`SELECT customer_id, amount, currency, exchange_rate, deposit_account_id, date, method FROM payments_received WHERE id = ${id}`))!;
    const cur = await rows<{ invoice_id: string; amount_applied: string }>(w, sql`SELECT invoice_id, amount_applied FROM payment_applications WHERE payment_id = ${id}`);
    const keepAmount = r.chance(0.5);
    // Re-apply: scale existing applications down, maybe add an open invoice.
    const apps = sortByOrder(w, cur.map((c) => ({ id: c.invoice_id, amt: c.amount_applied }))).map((c) => ({
      invoiceId: c.id,
      amountApplied: r.chance(0.6) ? c.amt : toAmountString(Money.round2(Money.mul(c.amt, r.frac()))),
    }));
    let total = apps.reduce((s, a) => s.plus(Money.of(a.amountApplied)), Money.zero());
    if (r.chance(0.3)) {
      const inv = r.pick((await openInvoicesOf(w, p.customer_id, (p.currency as 'EUR' | null) ?? null)).filter((i) => !apps.some((a) => a.invoiceId === i.id) && new Date(i.date) <= new Date(p.date)));
      if (inv) {
        const amt = part(r, inv.balance_due);
        apps.push({ invoiceId: inv.id, amountApplied: amt });
        total = total.plus(Money.of(amt));
      }
    }
    const amount = keepAmount && Money.of(p.amount).greaterThanOrEqualTo(total) ? p.amount : toAmountString(total.plus(r.chance(0.3) ? Money.of(r.money(1, 20)) : 0));
    await updatePayment(w.ctx, id, {
      customerId: p.customer_id,
      date: new Date(p.date),
      method: p.method as never,
      amount,
      depositAccountId: p.deposit_account_id,
      applications: apps.filter((a) => Money.of(a.amountApplied).greaterThan(0)),
      ...(p.currency ? { currency: p.currency, exchangeRate: p.exchange_rate } : {}),
    } as never);
  }],
  voidPayment: [2, async (w, r) => {
    const id = await pickLive(w, r, 'pay', 'payments_received', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    await voidPayment(w.ctx, id);
  }],
  bounceCheck: [1, async (w, r) => {
    const id = await pickLive(w, r, 'pay', 'payments_received', sql`voided_at IS NULL AND bounced_at IS NULL AND currency IS NULL`);
    if (!id) return SKIP;
    const pd = (await one<{ d: Date }>(w, sql`SELECT GREATEST(p.date, COALESCE((SELECT MAX(d.date) FROM deposit_lines l JOIN deposits d ON d.id = l.deposit_id WHERE l.payment_id = p.id AND d.voided_at IS NULL), p.date)) AS d FROM payments_received p WHERE p.id = ${id}`))!;
    const reopened = (await rows<{ invoice_id: string }>(w, sql`SELECT invoice_id FROM payment_applications WHERE payment_id = ${id}`)).map((x) => x.invoice_id);
    const bounceAt = r.dayFrom(pd.d, ...lastOf(w, id, ...reopened));
    // The bounce reopens the invoices: later payments on them are dated after it.
    touch(w, bounceAt, id, ...reopened);
    await recordBouncedCheck(w.ctx, {
      paymentId: id,
      date: bounceAt,
      bankFee: r.chance(0.5) ? r.money(5, 35) : null,
      customerFee: r.chance(0.3) ? r.money(10, 40) : null,
    });
  }],
  deposit: [7, async (w, r) => {
    const und = await listUndepositedPayments(w.ctx);
    const eur = r.chance(0.2);
    const pool = sortByOrder(w, und.filter((u) => (eur ? u.currency === 'EUR' : !u.currency)));
    const chosen = pool.filter(() => r.chance(0.6));
    const extra = r.chance(0.2);
    if (!chosen.length && !extra) return SKIP;
    const total = chosen.reduce((s, c) => s.plus(Money.of(c.amount)), Money.zero());
    const d = await createDeposit(w.ctx, {
      depositAccountId: eur ? w.acct['1020'] : r.pick([w.acct['1000'], w.acct['1010']])!,
      date: chosen.length ? r.dayFrom(...chosen.map((c) => c.date)) : r.day(),
      paymentIds: chosen.filter((c) => c.kind === 'payment').map((c) => c.id),
      salesReceiptIds: chosen.filter((c) => c.kind === 'sales_receipt').map((c) => c.id),
      invoicePaymentIds: chosen.filter((c) => c.kind === 'invoice_payment').map((c) => c.id),
      extraLines: extra ? [{ accountId: r.pick([w.acct['3000'], w.acct['4900']])!, amount: r.money(1, 100) }] : [],
      cashBack: !eur && total.greaterThan(5) && r.chance(0.1) ? { accountId: w.acct['6300'], amount: toAmountString(Money.round2(total.times('0.1'))) } : null,
    } as never);
    track(w, 'dep', d.id);
  }],
  editDeposit: [2, async (w, r) => {
    const id = await pickLive(w, r, 'dep', 'deposits', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    const d = await getDeposit(w.ctx, id);
    const lines = d.lines as Array<Record<string, unknown>>;
    const payIds = lines.map((l) => l.paymentId as string | null).filter((x): x is string => !!x);
    const descr = lines.map((l) => String(l.description ?? ''));
    const srIds = w.docs.sr.filter((s) => descr.some((x) => x.endsWith(s)));
    const invIds = w.docs.inv.filter((s) => descr.some((x) => x.endsWith(s)));
    const dropOne = r.chance(0.5) && payIds.length > 1;
    const und = sortByOrder(w, (await listUndepositedPayments(w.ctx)).filter((u) => (u.currency ?? null) === ((d as { currency?: string | null }).currency ?? null) && new Date(u.date) <= new Date((d as { date: Date }).date)));
    const add = r.chance(0.4) ? r.pick(und) : undefined;
    await updateDeposit(w.ctx, id, {
      depositAccountId: (d as { depositAccountId: string }).depositAccountId,
      date: new Date((d as { date: Date }).date),
      paymentIds: [...(dropOne ? payIds.slice(1) : payIds), ...(add?.kind === 'payment' ? [add.id] : [])],
      salesReceiptIds: [...srIds, ...(add?.kind === 'sales_receipt' ? [add.id] : [])],
      invoicePaymentIds: [...invIds, ...(add?.kind === 'invoice_payment' ? [add.id] : [])],
      extraLines: lines
        .filter((l) => !l.paymentId && !String(l.description ?? '').match(/^(sales_receipt|invoice_payment|receipt|inv)/i) && l.accountId && !srIds.length && !invIds.length && false)
        .map(() => ({ accountId: w.acct['3000'], amount: '1.00' })),
    } as never);
  }],
  removeFromDeposit: [1, async (w, r) => {
    const id = await pickLive(w, r, 'dep', 'deposits', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    const d = await getDeposit(w.ctx, id);
    const payIds = (d.lines as Array<{ paymentId: string | null }>).map((l) => l.paymentId).filter((x): x is string => !!x);
    const p = r.pick(sortByOrder(w, payIds.map((x) => ({ id: x }))));
    if (!p) return SKIP;
    await removePaymentFromDeposit(w.ctx, id, p.id);
  }],
  voidDeposit: [2, async (w, r) => {
    const id = await pickLive(w, r, 'dep', 'deposits', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    await voidDeposit(w.ctx, id);
  }],

  // ---------------- purchases ----------------
  bill: [12, async (w, r) => {
    const eur = r.chance(0.12);
    const b = await createBill(w.ctx, {
      vendorId: eur ? w.eurVend : r.pick(w.vend)!,
      date: r.day(),
      lines: purchaseLines(w, r, { eur }),
      ...(eur ? { currency: 'EUR', exchangeRate: r.rate() } : {}),
    } as never);
    track(w, 'bill', b.id);
  }],
  editBill: [3, async (w, r) => {
    const id = await pickLive(w, r, 'bill', 'bills', sql`status <> 'void'`);
    if (!id) return SKIP;
    const b = (await one<{ vendor_id: string; currency: string | null; exchange_rate: string | null; date: Date; settled: string }>(
      w, sql`SELECT vendor_id, currency, exchange_rate, date, CAST(amount_paid AS NUMERIC) + COALESCE(CAST(amount_credited AS NUMERIC), 0) AS settled FROM bills WHERE id = ${id}`))!;
    await updateBill(w.ctx, id, {
      vendorId: b.vendor_id,
      date: Money.isZero(b.settled) && r.chance(0.4) ? r.day() : new Date(b.date),
      lines: purchaseLines(w, r, { eur: !!b.currency }),
      ...(b.currency ? { currency: b.currency, exchangeRate: b.exchange_rate } : {}),
    } as never);
  }],
  voidBill: [2, async (w, r) => {
    const id = await pickLive(w, r, 'bill', 'bills', sql`status <> 'void'`);
    if (!id) return SKIP;
    await voidBill(w.ctx, id);
  }],
  payBills: [10, async (w, r) => {
    const eur = r.chance(0.15);
    const vendorId = eur ? w.eurVend : r.pick(w.vend)!;
    const open = await openBillsOf(w, vendorId);
    if (!open.length) return SKIP;
    const chosen = open.filter(() => r.chance(0.6));
    if (!chosen.length) chosen.push(open[0]);
    const withDisc = r.chance(0.1);
    const applications = chosen.map((b) => {
      const amt = part(r, b.balance_due);
      const disc = withDisc ? Money.round2(Money.mul(Money.sub(b.balance_due, amt), '0.5')) : Money.zero();
      return { billId: b.id, amountApplied: amt, ...(disc.greaterThan(0) ? { discountTaken: toAmountString(disc) } : {}) };
    });
    let vendorCreditsUse: Array<{ vendorCreditId: string; billId: string; amount: string }> | undefined;
    let vcDate: Date | undefined;
    if (r.chance(0.12)) {
      const vc = await one<{ id: string; unapplied: string; date: Date }>(
        w, sql`SELECT id, unapplied, date FROM vendor_credits WHERE company_id = ${w.ctx.companyId} AND vendor_id = ${vendorId}
               AND status <> 'void' AND CAST(unapplied AS NUMERIC) > 0 ORDER BY date, total LIMIT 1`);
      const a = applications[0];
      const left = Money.sub(Money.sub(chosen[0].balance_due, a.amountApplied), a.discountTaken ?? 0);
      if (vc && left.greaterThan(0)) {
        vendorCreditsUse = [{ vendorCreditId: vc.id, billId: a.billId, amount: part(r, min(vc.unapplied, toAmountString(left))) }];
        vcDate = [new Date(vc.date), ...lastOf(w, vc.id)].sort((a, b) => b.getTime() - a.getTime())[0];
      }
    }
    const card = !eur && r.chance(0.2);
    // Pay Bills with credits saves through payBillsWithCredits (payBills itself ignores vendorCredits).
    const pay = vendorCreditsUse ? (x: never) => payBillsWithCredits(w.ctx, x).then((res) => res.payment) : (x: never) => payBills(w.ctx, x);
    const bp = await pay({
      vendorId,
      date: r.dayFrom(...chosen.map((c) => c.date), vcDate),
      method: card ? 'credit_card' : 'check',
      paymentAccountId: eur ? w.acct['1020'] : card ? w.acct['2100'] : w.acct['1000'],
      discountAccountId: withDisc ? w.acct['4900'] : null,
      applications,
      vendorCredits: vendorCreditsUse,
      ...(eur ? { exchangeRate: r.rate() } : {}),
    } as never);
    track(w, 'bp', (bp as { id: string } | null)?.id);
  }],
  editBillPayment: [2, async (w, r) => {
    const id = await pickLive(w, r, 'bp', 'bill_payments', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    const bp = (await one<{ vendor_id: string; method: string; payment_account_id: string; date: Date; exchange_rate: string | null; currency: string | null }>(
      w, sql`SELECT vendor_id, method, payment_account_id, date, exchange_rate, currency FROM bill_payments WHERE id = ${id}`))!;
    const apps = await rows<{ bill_id: string; amount_applied: string }>(w, sql`SELECT bill_id, amount_applied FROM bill_payment_applications WHERE bill_payment_id = ${id}`);
    const sorted = sortByOrder(w, apps.map((a) => ({ id: a.bill_id, amt: a.amount_applied })));
    if (!sorted.length) return SKIP;
    await updateBillPayment(w.ctx, id, {
      vendorId: bp.vendor_id,
      date: new Date(bp.date),
      method: bp.method as never,
      paymentAccountId: bp.payment_account_id,
      applications: sorted.map((a) => ({ billId: a.id, amountApplied: r.chance(0.5) ? a.amt : toAmountString(Money.round2(Money.mul(a.amt, r.frac()))) }))
        .filter((a) => Money.of(a.amountApplied).greaterThan(0)),
      ...(bp.currency ? { exchangeRate: bp.exchange_rate } : {}),
    } as never);
  }],
  voidBillPayment: [2, async (w, r) => {
    const id = await pickLive(w, r, 'bp', 'bill_payments', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    await voidBillPayment(w.ctx, id);
  }],
  vendorCredit: [4, async (w, r) => {
    const eur = r.chance(0.12);
    const lines = r.chance(0.6)
      ? [{ accountId: r.pick([w.acct['6300'], w.acct['6600']]), amount: r.money(1, 80) }]
      : [{ itemId: r.pick([...w.item.avg, ...w.item.fifo]), quantity: r.int(1, 3), unitCost: r.money(1, 10) }];
    const vc = await createVendorCredit(w.ctx, {
      vendorId: eur ? w.eurVend : r.pick(w.vend)!,
      date: r.day(),
      lines,
      ...(eur ? { currency: 'EUR', exchangeRate: r.rate() } : {}),
    } as never);
    track(w, 'vc', vc.id);
  }],
  applyVendorCredit: [4, async (w, r) => {
    const id = await pickLive(w, r, 'vc', 'vendor_credits', sql`status <> 'void' AND CAST(unapplied AS NUMERIC) > 0`);
    if (!id) return SKIP;
    const vc = (await one<{ vendor_id: string; unapplied: string; currency: string | null; date: Date }>(w, sql`SELECT vendor_id, unapplied, currency, date FROM vendor_credits WHERE id = ${id}`))!;
    const b = r.pick((await openBillsOf(w, vc.vendor_id)).filter((x) => (x.currency ?? null) === (vc.currency ?? null)));
    if (!b) return SKIP;
    let at: Date;
    await applyToBill(w.ctx, { vendorCreditId: id, billId: b.id, amount: part(r, min(vc.unapplied, b.balance_due)), date: (at = r.dayFrom(vc.date, b.date, ...lastOf(w, id, b.id))) });
    touch(w, at, id, b.id);
  }],
  unapplyVendorCredit: [1, async (w, r) => {
    const id = await pickLive(w, r, 'vc', 'vendor_credits', sql`status <> 'void' AND CAST(unapplied AS NUMERIC) < CAST(total AS NUMERIC)`);
    if (!id) return SKIP;
    const vc = (await one<{ vendor_id: string }>(w, sql`SELECT vendor_id FROM vendor_credits WHERE id = ${id}`))!;
    const bills = await liveDocs(w, 'bill', 'bills', sql`vendor_id = ${vc.vendor_id} AND status <> 'void' AND CAST(amount_credited AS NUMERIC) > 0`);
    const billId = r.pick(bills);
    if (!billId) return SKIP;
    const dates = await one<{ c: Date; b: Date }>(w, sql`SELECT (SELECT date FROM vendor_credits WHERE id = ${id}) AS c, (SELECT date FROM bills WHERE id = ${billId}) AS b`);
    const at = r.dayFrom(dates?.c, dates?.b, ...lastOf(w, id, billId));
    await unapplyFromBill(w.ctx, { vendorCreditId: id, billId, amount: r.money(1, 10), date: at });
    touch(w, at, id, billId);
  }],
  refundVendorCredit: [1, async (w, r) => {
    const id = await pickLive(w, r, 'vc', 'vendor_credits', sql`status <> 'void' AND CAST(unapplied AS NUMERIC) > 0`);
    if (!id) return SKIP;
    const vc = (await one<{ unapplied: string; currency: string | null; date: Date }>(w, sql`SELECT unapplied, currency, date FROM vendor_credits WHERE id = ${id}`))!;
    let at: Date;
    await refundVendorCredit(w.ctx, {
      vendorCreditId: id,
      bankAccountId: vc.currency ? w.acct['1020'] : w.acct['1000'],
      amount: part(r, vc.unapplied),
      date: (at = r.dayFrom(vc.date, ...lastOf(w, id))),
      ...(vc.currency ? { exchangeRate: r.rate() } : {}),
    });
    touch(w, at, id);
  }],
  editVendorCredit: [1, async (w, r) => {
    const id = await pickLive(w, r, 'vc', 'vendor_credits', sql`status <> 'void'`);
    if (!id) return SKIP;
    const vc = (await one<{ vendor_id: string; currency: string | null; exchange_rate: string | null; date: Date; unapplied: string; total: string }>(
      w, sql`SELECT vendor_id, currency, exchange_rate, date, unapplied, total FROM vendor_credits WHERE id = ${id}`))!;
    await updateVendorCredit(w.ctx, id, {
      vendorId: vc.vendor_id,
      date: Money.eq(vc.unapplied, vc.total) && r.chance(0.4) ? r.day() : new Date(vc.date),
      lines: [{ accountId: w.acct['6300'], amount: r.money(1, 80) }],
      ...(vc.currency ? { currency: vc.currency, exchangeRate: vc.exchange_rate } : {}),
    } as never);
  }],
  voidVendorCredit: [1, async (w, r) => {
    const id = await pickLive(w, r, 'vc', 'vendor_credits', sql`status <> 'void'`);
    if (!id) return SKIP;
    await voidVendorCredit(w.ctx, id);
  }],
  check: [6, async (w, r) => {
    const eur = r.chance(0.1);
    const method = eur ? 'check' : r.pick(['check', 'check', 'credit_card', 'cash'] as const)!;
    const e = await createExpense(w.ctx, {
      vendorId: eur ? w.eurVend : r.pick(w.vend)!,
      date: r.day(),
      method,
      paymentAccountId: eur ? w.acct['1020'] : method === 'credit_card' ? w.acct['2100'] : w.acct['1000'],
      lines: purchaseLines(w, r, { eur }),
      isRefund: !eur && r.chance(0.04),
      ...(eur ? { currency: 'EUR', exchangeRate: r.rate() } : {}),
    } as never);
    track(w, 'chk', e.id);
  }],
  editCheck: [2, async (w, r) => {
    const id = await pickLive(w, r, 'chk', 'expenses', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    const e = (await one<{ vendor_id: string; method: string; payment_account_id: string; date: Date; currency: string | null; exchange_rate: string | null }>(
      w, sql`SELECT vendor_id, method, payment_account_id, date, currency, exchange_rate FROM expenses WHERE id = ${id}`))!;
    await updateExpense(w.ctx, id, {
      vendorId: e.vendor_id,
      date: r.chance(0.5) ? new Date(e.date) : r.day(),
      method: e.method as never,
      paymentAccountId: e.payment_account_id,
      lines: purchaseLines(w, r, { eur: !!e.currency }),
      ...(e.currency ? { currency: e.currency, exchangeRate: e.exchange_rate } : {}),
    } as never);
  }],
  voidCheck: [1, async (w, r) => {
    const id = await pickLive(w, r, 'chk', 'expenses', sql`voided_at IS NULL`);
    if (!id) return SKIP;
    await voidExpense(w.ctx, id);
  }],
  itemReceipt: [4, async (w, r) => {
    const vendorId = r.pick(w.vend)!;
    const poId = r.chance(0.3)
      ? r.pick(await liveDocs(w, 'po', 'purchase_orders', sql`vendor_id = ${vendorId} AND status = 'open'`))
      : undefined;
    let lines: Array<Record<string, unknown>>;
    let poDate: Date | undefined;
    if (poId) {
      const po = await getPurchaseOrder(w.ctx, poId);
      poDate = (po as { date: Date }).date;
      lines = (po.lines as Array<{ itemId: string | null; quantity: string; rate: string }>)
        .filter((l) => l.itemId)
        .map((l) => ({ itemId: l.itemId, quantity: Math.max(1, Math.floor(Number(l.quantity) * Number(r.frac()))), unitCost: l.rate }));
      if (!lines.length) return SKIP;
    } else {
      lines = purchaseLines(w, r, { inventoryOnly: true });
    }
    const ir = await createItemReceipt(w.ctx, { vendorId, date: poDate ? r.dayFrom(poDate) : r.day(), purchaseOrderId: poId ?? null, lines } as never);
    track(w, 'ir', ir.id);
  }],
  editItemReceipt: [1, async (w, r) => {
    const id = await pickLive(w, r, 'ir', 'item_receipts', sql`status = 'open' AND voided_at IS NULL`);
    if (!id) return SKIP;
    const ir = (await one<{ vendor_id: string; date: Date }>(w, sql`SELECT vendor_id, date FROM item_receipts WHERE id = ${id}`))!;
    await updateItemReceipt(w.ctx, id, { vendorId: ir.vendor_id, date: r.chance(0.5) ? new Date(ir.date) : r.day(), lines: purchaseLines(w, r, { inventoryOnly: true }) } as never);
  }],
  receiptToBill: [3, async (w, r) => {
    const id = await pickLive(w, r, 'ir', 'item_receipts', sql`status = 'open' AND voided_at IS NULL`);
    if (!id) return SKIP;
    const ir = (await one<{ date: Date }>(w, sql`SELECT date FROM item_receipts WHERE id = ${id}`))!;
    const b = await convertReceiptToBill(w.ctx, id, r.chance(0.5) ? { date: r.dayFrom(ir.date) } : undefined);
    track(w, 'bill', (b as { id: string }).id);
  }],
  voidItemReceipt: [1, async (w, r) => {
    const id = await pickLive(w, r, 'ir', 'item_receipts', sql`voided_at IS NULL AND status <> 'void'`);
    if (!id) return SKIP;
    await voidItemReceipt(w.ctx, id);
  }],
  purchaseOrder: [3, async (w, r) => {
    const lines = [];
    for (let i = r.int(1, 3); i > 0; i--) {
      lines.push(r.chance(0.8)
        ? { itemId: r.pick([...w.item.avg, ...w.item.comps]), quantity: r.int(2, 12), rate: r.money(1, 12) }
        : { accountId: w.acct['6300'], description: 'Supplies', quantity: 1, rate: r.money(5, 90) });
    }
    const po = await createPurchaseOrder(w.ctx, { vendorId: r.pick(w.vend)!, date: r.day(), lines } as never);
    track(w, 'po', po.id);
  }],
  poToBill: [3, async (w, r) => {
    const id = await pickLive(w, r, 'po', 'purchase_orders', sql`status = 'open'`);
    if (!id) return SKIP;
    const po = await getPurchaseOrder(w.ctx, id);
    const lines = (po.lines as Array<{ id: string; quantity: string; quantityBilled?: string | null; receivedQuantity?: string | null }>).map((l) => ({
      lineId: l.id,
      quantity: Math.max(1, Math.floor((Number(l.quantity) - Number(l.quantityBilled ?? 0)) * Number(r.frac()))),
    }));
    const poDate = (po as { date: Date }).date;
    const b = await convertPoToBill(w.ctx, id, r.chance(0.5) ? { lines, date: r.dayFrom(poDate) } : { date: r.dayFrom(poDate) });
    track(w, 'bill', (b as { id: string }).id);
  }],

  // ---------------- inventory ----------------
  adjustQty: [4, async (w, r) => {
    const itemId = r.pick([...w.item.avg, ...w.item.comps, w.item.kit])!;
    const it = (await one<{ quantity_on_hand: string }>(w, sql`SELECT quantity_on_hand FROM items WHERE id = ${itemId}`))!;
    const up = r.chance(0.6) || !Money.of(it.quantity_on_hand).greaterThan(0);
    await adjustInventory(w.ctx, {
      itemId,
      quantityChange: up ? r.int(1, 20) : -Math.min(r.int(1, 10), Math.floor(Number(it.quantity_on_hand))) || -1,
      unitCost: up ? r.money(0.5, 14) : null,
      date: r.day(),
    });
  }],
  fifoReceive: [3, async (w, r) => {
    await receiveStock(w.ctx, { itemId: r.pick(w.item.fifo)!, quantity: r.int(1, 20), unitCost: r.money(1, 14), date: r.day() });
  }],
  fifoConsume: [2, async (w, r) => {
    await consumeStock(w.ctx, { itemId: r.pick(w.item.fifo)!, quantity: r.int(1, 6), date: r.day(), purpose: r.chance(0.5) ? 'cogs' : 'adjustment' });
  }],
  physicalCount: [3, async (w, r) => {
    const itemId = r.pick([...w.item.avg, ...w.item.comps, ...w.item.fifo, w.item.kit])!;
    const it = (await one<{ quantity_on_hand: string }>(w, sql`SELECT quantity_on_hand FROM items WHERE id = ${itemId}`))!;
    const counted = Math.max(0, Math.round(Number(it.quantity_on_hand)) + r.int(-5, 5));
    await physicalCount(w.ctx, { itemId, countedQty: counted, date: r.day() });
  }],
  valueAdjust: [2, async (w, r) => {
    const itemId = r.pick([...w.item.avg, ...w.item.comps, ...w.item.fifo])!;
    await adjustInventoryValue(w.ctx, r.chance(0.5)
      ? { itemId, newUnitCost: r.money(0.5, 12), date: r.day() }
      : { itemId, newTotalValue: r.money(10, 300), date: r.day() });
  }],
  siteTransfer: [3, async (w, r) => {
    const itemId = r.pick([...w.item.avg, ...w.item.fifo, ...w.item.comps])!;
    const toAnnex = r.chance(0.6);
    const q = (await siteQuantities(w.ctx, [itemId])).get(itemId);
    const avail = q?.get(toAnnex ? w.sites.main : w.sites.annex) ?? Money.zero();
    if (!avail.greaterThan(0)) return SKIP;
    const t = await createInventoryTransfer(w.ctx, {
      date: r.day(),
      fromSiteId: toAnnex ? w.sites.main : w.sites.annex,
      toSiteId: toAnnex ? w.sites.annex : w.sites.main,
      lines: [{ itemId, quantity: Math.max(1, Math.floor(Number(avail) * Number(r.frac()))) }],
    });
    track(w, 'itx', t.id);
  }],
  voidSiteTransfer: [1, async (w, r) => {
    const id = await pickLive(w, r, 'itx', 'inventory_transfers', sql`status <> 'void'`);
    if (!id) return SKIP;
    await voidInventoryTransfer(w.ctx, id);
  }],
  build: [3, async (w, r) => {
    await buildAssembly(w.ctx, { assemblyItemId: w.item.kit, quantity: r.int(1, 4), date: r.day() });
  }],
  unbuild: [1, async (w, r) => {
    await unbuildAssembly(w.ctx, { assemblyItemId: w.item.kit, quantity: r.int(1, 2), date: r.day() });
  }],

  // ---------------- banking ----------------
  transfer: [3, async (w, r) => {
    const roll = r.f();
    const t = roll < 0.4
      ? await createTransfer(w.ctx, { date: r.day(), fromAccountId: w.acct['1000'], toAccountId: w.acct['1010'], amount: r.money(1, 400) })
      : roll < 0.7
        ? await createTransfer(w.ctx, { date: r.day(), fromAccountId: w.acct['1010'], toAccountId: w.acct['1000'], amount: r.money(1, 400) })
        : roll < 0.85
          ? await createTransfer(w.ctx, { date: r.day(), fromAccountId: w.acct['1000'], toAccountId: w.acct['1020'], amount: r.money(10, 400), exchangeRate: (1 / Number(r.rate())).toFixed(6) })
          : await createTransfer(w.ctx, { date: r.day(), fromAccountId: w.acct['1020'], toAccountId: w.acct['1000'], amount: r.money(5, 100), exchangeRate: r.rate() });
    track(w, 'xfer', (t as { id: string }).id);
  }],
  editTransfer: [1, async (w, r) => {
    const id = await pickLive(w, r, 'xfer', 'transfers', sql`true`);
    if (!id) return SKIP;
    const t = (await one<{ from_account_id: string; to_account_id: string; exchange_rate: string | null; currency: string | null; to_currency: string | null }>(
      w, sql`SELECT from_account_id, to_account_id, exchange_rate, currency, to_currency FROM transfers WHERE id = ${id}`))!;
    const cross = (t.currency ?? null) !== (t.to_currency ?? null);
    await updateTransfer(w.ctx, id, {
      date: r.day(),
      fromAccountId: t.from_account_id,
      toAccountId: t.to_account_id,
      amount: r.money(1, 200),
      ...(cross ? { exchangeRate: t.currency ? r.rate() : (1 / Number(r.rate())).toFixed(6) } : {}),
    });
  }],
  voidTransfer: [1, async (w, r) => {
    const id = await pickLive(w, r, 'xfer', 'transfers', sql`true`);
    if (!id) return SKIP;
    await voidTransfer(w.ctx, id);
  }],
  journal: [5, async (w, r) => {
    const amt = r.money(1, 600);
    const roll = r.f();
    let lines;
    if (roll < 0.25) {
      // Customer charge / credit on A/R (journal open item).
      const c = r.pick(w.cust)!;
      lines = r.chance(0.6)
        ? [{ accountId: w.acct['1200'], debit: amt, entityType: 'customer', entityId: c }, { accountId: w.acct['4900'], credit: amt }]
        : [{ accountId: w.acct['4900'], debit: amt }, { accountId: w.acct['1200'], credit: amt, entityType: 'customer', entityId: c }];
    } else if (roll < 0.45) {
      const v = r.pick(w.vend)!;
      lines = r.chance(0.6)
        ? [{ accountId: w.acct['6000'], debit: amt }, { accountId: w.acct['2000'], credit: amt, entityType: 'vendor', entityId: v }]
        : [{ accountId: w.acct['2000'], debit: amt, entityType: 'vendor', entityId: v }, { accountId: w.acct['6000'], credit: amt }];
    } else if (roll < 0.6) {
      lines = [{ accountId: w.acct['1000'], debit: amt }, { accountId: w.acct['3000'], credit: amt }];
    } else {
      lines = [
        { accountId: r.pick([w.acct['6000'], w.acct['6100'], w.acct['6700']])!, debit: amt },
        { accountId: r.pick([w.acct['1000'], w.acct['2100']])!, credit: amt },
      ];
    }
    const e = await createManualEntry(w.ctx, { date: r.day(), description: 'Fuzz JE', lines: lines as never });
    track(w, 'je', e.id);
  }],
  editJournal: [1, async (w, r) => {
    const id = await pickLive(w, r, 'je', 'journal_entries', sql`status = 'posted'`);
    if (!id) return SKIP;
    const amt = r.money(1, 300);
    const e = await updateEntry(w.ctx, id, {
      date: r.day(),
      description: 'Edited JE',
      lines: [{ accountId: w.acct['6000'], debit: amt }, { accountId: w.acct['1000'], credit: amt }],
    });
    track(w, 'je', (e as { id: string }).id);
  }],
  reverseJournal: [1, async (w, r) => {
    const id = await pickLive(w, r, 'je', 'journal_entries', sql`status = 'posted'`);
    if (!id) return SKIP;
    const e = await reverseEntry(w.ctx, id);
    track(w, 'je', (e as { id?: string })?.id);
  }],
  voidJournal: [1, async (w, r) => {
    const id = await pickLive(w, r, 'je', 'journal_entries', sql`status = 'posted'`);
    if (!id) return SKIP;
    await voidEntry(w.ctx, id);
  }],
};

export const OP_NAMES = Object.keys(OPS);

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

export interface Violation {
  id: string;
  msg: string;
}

const FAR = new Date(Date.UTC(2099, 11, 31, 12));
const WINDOW_START = new Date(Date.UTC(2025, 0, 1));

type Dec = ReturnType<typeof Money.zero>;

/** Home amount a foreign undeposited item put into Undeposited Funds (what a deposit relieves). */
async function postedUfHome(w: World, u: { id: string; kind: string }): Promise<Dec> {
  const ref = u.kind === 'payment' ? sql`e.id = (SELECT posted_entry_id FROM payments_received WHERE id = ${u.id})` : sql`e.source_ref = ${'invoice:' + u.id}`;
  const [x] = await rows<{ v: string }>(
    w,
    sql`SELECT COALESCE(SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0)),0) AS v FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
        WHERE e.company_id = ${w.ctx.companyId} AND e.status = 'posted' AND l.account_id = ${w.acct['1050']} AND ${ref}`,
  );
  return Money.of(x?.v ?? 0);
}

async function glByCode(w: World, asOf?: Date): Promise<Map<string, Dec>> {
  const tb = await trialBalance(w.ctx, asOf);
  const m = new Map<string, Dec>();
  for (const r of tb.rows) m.set(r.code, Money.sub(r.debit, r.credit)); // debit-positive
  return m;
}

const d2 = (x: Dec | string | number | null | undefined) => toAmountString(Money.of(x ?? 0));

export async function checkInvariants(w: World, r: R): Promise<Violation[]> {
  const out: Violation[] = [];
  const bad = (id: string, msg: string) => out.push({ id, msg });
  const ctx = w.ctx;

  // 1. Trial balance / books in balance / integrity checker.
  const gl = await glByCode(w);
  const g = (code: string) => gl.get(code) ?? Money.zero();
  const status = await booksInBalance(ctx);
  if (!status.inBalance) bad('books', `booksInBalance false: ${JSON.stringify({ tb: status.trialBalance.detail, bs: status.balanceSheet.detail, cash: status.cashBasisBalanceSheet.detail, acc: status.accountBalances.detail, g: status.guards.missing })}`);
  const integ = await verifyIntegrity(ctx);
  for (const c of integ.checks) if (!c.ok) bad('integrity', `${c.name}: ${c.detail}`);

  // 2. A/R: GL 1200 = aging total = per-customer GL = open documents.
  const ar = await arAging(ctx, FAR);
  if (!Money.eq(ar.totals.total, g('1200'))) bad('ar-aging', `A/R aging ${ar.totals.total} != GL 1200 ${d2(g('1200'))}`);
  const agingByCust = new Map(ar.rows.map((x) => [x.id, x.total]));
  // Per customer: the aging row = the Customer Balance Summary (the name ledger).
  const cbs = await customerBalanceSummary(ctx, { asOf: '2099-12-31' } as never);
  const cbsByCust = new Map<string, string>();
  for (const row of cbs.rows) if (row.id.startsWith('bal:') && row.id !== 'bal:total') cbsByCust.set(row.id.slice(4), String(row.cells.balance));
  for (const id of new Set([...agingByCust.keys(), ...cbsByCust.keys()])) {
    const a = agingByCust.get(id) ?? '0.00';
    const b = cbsByCust.get(id) ?? '0.00';
    if (!Money.eq(a, b)) bad('ar-name', `customer ${id}: A/R aging ${a} != customer balance summary ${b}`);
  }
  // Open documents (home customers only; EUR documents are aged at their home value).
  for (const c of w.cust) {
    const [o] = await rows<{ inv: string; cm: string; pay: string }>(
      w,
      sql`SELECT
          (SELECT COALESCE(SUM(CAST(balance_due AS NUMERIC)),0) FROM invoices WHERE company_id = ${ctx.companyId} AND customer_id = ${c} AND status IN ('open','partial','overdue') AND currency IS NULL) AS inv,
          (SELECT COALESCE(SUM(CAST(unapplied AS NUMERIC)),0) FROM credit_memos WHERE company_id = ${ctx.companyId} AND customer_id = ${c} AND status <> 'void') AS cm,
          (SELECT COALESCE(SUM(CAST(unapplied AS NUMERIC)),0) FROM payments_received WHERE company_id = ${ctx.companyId} AND customer_id = ${c} AND voided_at IS NULL AND currency IS NULL) AS pay`,
    );
    const docs = Money.of(o.inv).minus(Money.of(o.cm)).minus(Money.of(o.pay));
    const ag = Money.of(agingByCust.get(c) ?? 0);
    // Journal open items: the aging and GL include them; documents do not. Compare docs only when
    // the customer has no manual A/R lines.
    const manual = (await rows(w, sql`SELECT 1 FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.company_id = ${ctx.companyId} AND l.account_id = ${w.acct['1200']} AND l.entity_id = ${c} AND e.source_ref = 'manual' LIMIT 1`)).length > 0;
    if (!manual && !Money.eq(docs, ag)) bad('ar-docs', `customer ${c}: open docs (inv ${d2(o.inv)} - cm ${d2(o.cm)} - pay ${d2(o.pay)} = ${d2(docs)}) != aging ${d2(ag)}`);
  }

  // 3. A/P: GL 2000 = aging total = per-vendor GL.
  const ap = await apAging(ctx, FAR);
  const apGl = g('2000').negated();
  if (!Money.eq(ap.totals.total, apGl)) bad('ap-aging', `A/P aging ${ap.totals.total} != GL 2000 ${d2(apGl)}`);
  const agingByVend = new Map(ap.rows.map((x) => [x.id, x.total]));
  const vbs = await vendorBalanceSummary(ctx, { asOf: '2099-12-31' } as never);
  const vbsByVend = new Map<string, string>();
  for (const row of vbs.rows) if (row.id.startsWith('bal:') && row.id !== 'bal:total') vbsByVend.set(row.id.slice(4), String(row.cells.balance));
  for (const id of new Set([...agingByVend.keys(), ...vbsByVend.keys()])) {
    const a = agingByVend.get(id) ?? '0.00';
    const b = vbsByVend.get(id) ?? '0.00';
    if (!Money.eq(a, b)) bad('ap-name', `vendor ${id}: A/P aging ${a} != vendor balance summary ${b}`);
  }
  for (const v of w.vend) {
    const [o] = await rows<{ bill: string; vc: string }>(
      w,
      sql`SELECT
          (SELECT COALESCE(SUM(CAST(balance_due AS NUMERIC)),0) FROM bills WHERE company_id = ${ctx.companyId} AND vendor_id = ${v} AND status <> 'void') AS bill,
          (SELECT COALESCE(SUM(CAST(unapplied AS NUMERIC)),0) FROM vendor_credits WHERE company_id = ${ctx.companyId} AND vendor_id = ${v} AND status <> 'void') AS vc`,
    );
    const manual = (await rows(w, sql`SELECT 1 FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.company_id = ${ctx.companyId} AND l.account_id = ${w.acct['2000']} AND l.entity_id = ${v} AND e.source_ref = 'manual' LIMIT 1`)).length > 0;
    const docs = Money.of(o.bill).minus(Money.of(o.vc));
    const ag = Money.of(agingByVend.get(v) ?? 0);
    if (!manual && !Money.eq(docs, ag)) bad('ap-docs', `vendor ${v}: open docs (bills ${d2(o.bill)} - credits ${d2(o.vc)} = ${d2(docs)}) != aging ${d2(ag)}`);
  }

  // 4. Undeposited Funds.
  const und = await listUndepositedPayments(ctx);
  let ufHome = Money.zero();
  for (const u of und) {
    if (!u.currency) ufHome = ufHome.plus(Money.of(u.amount));
    else {
      ufHome = ufHome.plus(await postedUfHome(w, u));
    }
  }
  if (!Money.eq(ufHome, g('1050'))) bad('uf', `Undeposited Funds GL ${d2(g('1050'))} != undeposited items ${d2(ufHome)} (${und.length} items)`);

  // 5. Item-receipt accrual (2050) = open (unbilled) item receipts.
  const accr = await one<{ id: string }>(w, sql`SELECT id FROM accounts WHERE company_id = ${ctx.companyId} AND code = '2050'`);
  if (accr) {
    const [o] = await rows<{ t: string }>(w, sql`SELECT COALESCE(SUM(CAST(total AS NUMERIC)),0) AS t FROM item_receipts WHERE company_id = ${ctx.companyId} AND status = 'open' AND voided_at IS NULL`);
    const accrGl = g('2050').negated();
    if (!Money.eq(o.t, accrGl)) bad('accrual', `item receipt accrual GL ${d2(accrGl)} != open receipts ${d2(o.t)}`);
  }

  // 6. Inventory: GL 1300 = valuation; FIFO layers = quantity on hand; sites never negative.
  const val = await inventoryValuation(ctx);
  // Average-cost items carry the cents a 4-decimal average cannot represent as a value remainder
  // (items.value_remainder, valid while value_remainder_avg = average_cost — migration 0061); the GL
  // holds it until the last unit leaves. So GL 1300 = valuation + carried remainders, exactly.
  const [rem] = await rows<{ r: string }>(
    w,
    sql`SELECT COALESCE(SUM(CAST(value_remainder AS NUMERIC)) FILTER (WHERE value_remainder_avg IS NOT NULL
          AND CAST(value_remainder_avg AS NUMERIC) = CAST(COALESCE(average_cost, '0') AS NUMERIC)), 0) AS r
        FROM items WHERE company_id = ${ctx.companyId} AND type = 'inventory' AND is_active
          AND id NOT IN (SELECT item_id FROM inventory_layers WHERE company_id = ${ctx.companyId})`,
  );
  const invDiff = Money.sub(Money.add(val.grandTotal, rem?.r ?? 0), g('1300'));
  if (!invDiff.isZero()) {
    // Exact to the cent: every average-cost path records its remainder, FIFO layers carry per-layer cents.
    bad('inv-gl', `inventory valuation ${val.grandTotal} + remainders ${d2(rem?.r)} != GL 1300 ${d2(g('1300'))} (diff ${d2(invDiff)})`);
  }
  const layerQty = await rows<{ item_id: string; q: string; neg: number }>(
    w, sql`SELECT item_id, COALESCE(SUM(quantity_remaining),0) AS q, COUNT(*) FILTER (WHERE quantity_remaining < 0)::int AS neg FROM inventory_layers WHERE company_id = ${ctx.companyId} GROUP BY item_id`);
  for (const l of layerQty) {
    const it = (await one<{ quantity_on_hand: string; name: string }>(w, sql`SELECT quantity_on_hand, name FROM items WHERE id = ${l.item_id}`))!;
    if (!Money.eq(l.q, it.quantity_on_hand)) bad('fifo-qty', `${it.name}: FIFO layers hold ${l.q} but quantity on hand is ${it.quantity_on_hand}`);
    if (l.neg > 0) bad('fifo-qty', `${it.name}: ${l.neg} negative layer(s)`);
  }
  for (const row of val.items) {
    if (Money.of(row.quantityOnHand).isNegative() || Money.of(row.totalValue).isNegative()) {
      bad('inv-neg', `${row.name}: negative stock/value qty ${row.quantityOnHand} value ${row.totalValue}`);
    }
  }
  const sq = await siteQuantities(ctx);
  for (const [itemId, bySite] of sq) {
    const ann = bySite.get(w.sites.annex);
    if (ann && ann.isNegative()) bad('site', `item ${itemId}: Annex site quantity ${ann.toFixed(4)} < 0`);
  }
  // Per-item: GL-attributed value vs subledger value (diagnostic; tolerance for 4dp averages).
  const asOfVal = await inventoryValuationAsOf(ctx, FAR);
  const subByItem = new Map(val.items.map((x) => [x.id, x]));
  for (const row of asOfVal.items) {
    const sub = subByItem.get(row.id);
    if (!sub) continue;
    const diff = Money.sub(row.valueAsOf, sub.totalValue);
    if (diff.abs().greaterThan('0.10')) bad('inv-item', `${row.name}: GL-attributed ${row.valueAsOf} vs valuation ${sub.totalValue} (qty ${sub.quantityOnHand} @ ${sub.averageCost}, ${sub.costingMethod})`);
  }

  // 7. Document bounds.
  const invBad = await rows<{ id: string; total: string; amount_paid: string; balance_due: string; retainage_amount: string | null; status: string }>(
    w,
    sql`SELECT id, total, amount_paid, balance_due, retainage_amount, status FROM invoices WHERE company_id = ${ctx.companyId} AND status NOT IN ('void','draft')
        AND (CAST(balance_due AS NUMERIC) < 0 OR CAST(balance_due AS NUMERIC) > CAST(total AS NUMERIC)
          OR CAST(balance_due AS NUMERIC) <> CAST(total AS NUMERIC) - COALESCE(CAST(retainage_amount AS NUMERIC),0) - CAST(amount_paid AS NUMERIC)
          OR (status = 'paid') <> (CAST(balance_due AS NUMERIC) = 0 AND CAST(total AS NUMERIC) - COALESCE(CAST(retainage_amount AS NUMERIC),0) > 0)
          OR CAST(amount_paid AS NUMERIC) < 0)`,
  );
  for (const x of invBad) bad('inv-bounds', `invoice ${x.id}: total ${x.total} paid ${x.amount_paid} retainage ${x.retainage_amount} due ${x.balance_due} status ${x.status}`);
  const billBad = await rows<{ id: string; total: string; amount_paid: string; amount_credited: string; balance_due: string; status: string }>(
    w,
    sql`SELECT id, total, amount_paid, amount_credited, balance_due, status FROM bills WHERE company_id = ${ctx.companyId} AND status <> 'void'
        AND (CAST(balance_due AS NUMERIC) < 0 OR CAST(balance_due AS NUMERIC) > CAST(total AS NUMERIC)
          OR CAST(balance_due AS NUMERIC) <> CAST(total AS NUMERIC) - CAST(amount_paid AS NUMERIC) - COALESCE(CAST(amount_credited AS NUMERIC),0)
          OR (status = 'paid') <> (CAST(balance_due AS NUMERIC) = 0 AND CAST(total AS NUMERIC) > 0)
          OR CAST(amount_paid AS NUMERIC) < 0 OR COALESCE(CAST(amount_credited AS NUMERIC),0) < 0)`,
  );
  for (const x of billBad) bad('bill-bounds', `bill ${x.id}: total ${x.total} paid ${x.amount_paid} credited ${x.amount_credited} due ${x.balance_due} status ${x.status}`);
  const cmBad = await rows<{ id: string; total: string; unapplied: string; refunded_amount: string | null }>(
    w,
    sql`SELECT id, total, unapplied, refunded_amount FROM credit_memos WHERE company_id = ${ctx.companyId} AND status <> 'void'
        AND (CAST(unapplied AS NUMERIC) < 0 OR CAST(unapplied AS NUMERIC) + COALESCE(CAST(refunded_amount AS NUMERIC),0) > CAST(total AS NUMERIC))`,
  );
  for (const x of cmBad) bad('cm-bounds', `credit memo ${x.id}: total ${x.total} unapplied ${x.unapplied} refunded ${x.refunded_amount}`);
  const cmApplied = await rows<{ id: string; total: string; unapplied: string; refunded: string; applied: string }>(
    w,
    sql`SELECT m.id, m.total, m.unapplied, COALESCE(m.refunded_amount, 0) AS refunded,
          (SELECT COALESCE(SUM(CAST(a.amount AS NUMERIC)),0) FROM credit_applications a WHERE a.credit_memo_id = m.id) AS applied
        FROM credit_memos m WHERE m.company_id = ${ctx.companyId} AND m.status <> 'void'`,
  );
  for (const x of cmApplied) {
    // unapplied = total - refunded - applied (applications made through credit_applications or legacy direct applies).
    if (Money.of(x.applied).greaterThan(0) && !Money.eq(Money.sub(Money.sub(x.total, x.refunded), x.applied), x.unapplied)) {
      bad('cm-apps', `credit memo ${x.id}: total ${x.total} - refunded ${x.refunded} - applications ${x.applied} != unapplied ${x.unapplied}`);
    }
  }
  const vcBad = await rows<{ id: string; total: string; unapplied: string }>(
    w,
    sql`SELECT id, total, unapplied FROM vendor_credits WHERE company_id = ${ctx.companyId} AND status <> 'void'
        AND (CAST(unapplied AS NUMERIC) < 0 OR CAST(unapplied AS NUMERIC) > CAST(total AS NUMERIC))`,
  );
  for (const x of vcBad) bad('vc-bounds', `vendor credit ${x.id}: total ${x.total} unapplied ${x.unapplied}`);
  const payBad = await rows<{ id: string; amount: string; unapplied: string; applied: string }>(
    w,
    sql`SELECT p.id, p.amount, p.unapplied,
          (SELECT COALESCE(SUM(CAST(a.amount_applied AS NUMERIC)),0) FROM payment_applications a WHERE a.payment_id = p.id) AS applied
        FROM payments_received p WHERE p.company_id = ${ctx.companyId} AND p.voided_at IS NULL
        AND (CAST(p.unapplied AS NUMERIC) < 0 OR CAST(p.unapplied AS NUMERIC) > CAST(p.amount AS NUMERIC))`,
  );
  for (const x of payBad) bad('pay-bounds', `payment ${x.id}: amount ${x.amount} unapplied ${x.unapplied} applied ${x.applied}`);
  // Invoice amountPaid = cash + discounts + credits applied.
  const invPaid = await rows<{ id: string; amount_paid: string; cash: string; credits: string }>(
    w,
    sql`SELECT i.id, i.amount_paid,
          (SELECT COALESCE(SUM(CAST(a.amount_applied AS NUMERIC) + CAST(a.discount_amount AS NUMERIC)),0) FROM payment_applications a JOIN payments_received p ON p.id = a.payment_id WHERE a.invoice_id = i.id AND p.voided_at IS NULL) AS cash,
          (SELECT COALESCE(SUM(CAST(c.amount AS NUMERIC)),0) FROM credit_applications c WHERE c.invoice_id = i.id) AS credits
        FROM invoices i WHERE i.company_id = ${ctx.companyId} AND i.status NOT IN ('void','draft')`,
  );
  for (const x of invPaid) {
    const sum = Money.add(x.cash, x.credits);
    if (Money.of(x.amount_paid).lessThan(sum)) bad('inv-paid', `invoice ${x.id}: amountPaid ${x.amount_paid} < cash+discount ${d2(x.cash)} + credits ${d2(x.credits)}`);
  }

  // 7b. Document headers vs their own postings (home documents): total = subtotal - discount + tax,
  //     the A/R / A/P / deposit line of the document's live entry = its total, and Sales Tax
  //     Payable = tax on live invoices + sales receipts - credit memos.
  const hdr = await rows<{ id: string; total: string; subtotal: string; discount: string; tax_amount: string }>(
    w,
    sql`SELECT id, total, subtotal, discount, tax_amount FROM invoices WHERE company_id = ${ctx.companyId} AND status NOT IN ('void','draft')
        AND CAST(total AS NUMERIC) <> CAST(subtotal AS NUMERIC) - CAST(discount AS NUMERIC) + CAST(tax_amount AS NUMERIC)`,
  );
  for (const x of hdr) bad('doc-header', `invoice ${x.id}: total ${x.total} != subtotal ${x.subtotal} - discount ${x.discount} + tax ${x.tax_amount}`);
  const docGl = await rows<{ kind: string; id: string; total: string; posted: string | null }>(
    w,
    sql`SELECT 'invoice' AS kind, i.id, i.total,
          (SELECT SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0)) FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
            WHERE e.company_id = i.company_id AND e.source_ref = 'invoice:' || i.id AND e.status = 'posted' AND l.account_id IN (${w.acct['1200']}, ${w.acct['1250']}, ${w.acct['1050']})) AS posted
        FROM invoices i WHERE i.company_id = ${ctx.companyId} AND i.status NOT IN ('void','draft') AND i.currency IS NULL
        UNION ALL
        SELECT 'bill', b.id, b.total,
          (SELECT SUM(COALESCE(l.credit,0) - COALESCE(l.debit,0)) FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
            WHERE e.company_id = b.company_id AND e.source_ref = 'bill:' || b.id AND e.status = 'posted' AND l.account_id = ${w.acct['2000']})
        FROM bills b WHERE b.company_id = ${ctx.companyId} AND b.status <> 'void' AND b.currency IS NULL
        UNION ALL
        SELECT 'credit_memo', m.id, m.total,
          (SELECT SUM(COALESCE(l.credit,0) - COALESCE(l.debit,0)) FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
            WHERE e.company_id = m.company_id AND e.source_ref = 'credit_memo:' || m.id AND e.status = 'posted' AND l.account_id = ${w.acct['1200']})
        FROM credit_memos m WHERE m.company_id = ${ctx.companyId} AND m.status <> 'void'
        UNION ALL
        SELECT 'vendor_credit', v.id, v.total,
          (SELECT SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0)) FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
            WHERE e.company_id = v.company_id AND e.source_ref = 'vendor_credit:' || v.id AND e.status = 'posted' AND l.account_id = ${w.acct['2000']})
        FROM vendor_credits v WHERE v.company_id = ${ctx.companyId} AND v.status <> 'void' AND v.currency IS NULL`,
  );
  for (const x of docGl) {
    if (!Money.eq(x.total, x.posted ?? 0)) bad('doc-gl', `${x.kind} ${x.id}: total ${x.total} but its live entry carries ${d2(x.posted)} on the control account`);
  }
  const [tax] = await rows<{ inv: string; sr: string; cm: string; fx: string }>(
    w,
    sql`SELECT
        (SELECT COALESCE(SUM(CAST(tax_amount AS NUMERIC)),0) FROM invoices WHERE company_id = ${ctx.companyId} AND status NOT IN ('void','draft') AND currency IS NULL) AS inv,
        (SELECT COALESCE(SUM(CAST(tax_amount AS NUMERIC)),0) FROM sales_receipts WHERE company_id = ${ctx.companyId} AND status <> 'void') AS sr,
        (SELECT COALESCE(SUM(CAST(tax_amount AS NUMERIC)),0) FROM credit_memos WHERE company_id = ${ctx.companyId} AND status <> 'void') AS cm,
        (SELECT COALESCE(SUM(COALESCE(l.credit,0) - COALESCE(l.debit,0)),0) FROM invoices i JOIN journal_entries e ON e.source_ref = 'invoice:' || i.id AND e.status = 'posted'
           JOIN journal_entry_lines l ON l.journal_entry_id = e.id
          WHERE i.company_id = ${ctx.companyId} AND i.currency IS NOT NULL AND l.account_id = ${w.acct['2200']}) AS fx`,
  );
  const taxDocs = Money.of(tax.inv).plus(Money.of(tax.sr)).minus(Money.of(tax.cm)).plus(Money.of(tax.fx));
  if (!Money.eq(taxDocs, g('2200').negated())) bad('sales-tax', `Sales Tax Payable GL ${d2(g('2200').negated())} != tax on documents ${d2(taxDocs)} (inv ${d2(tax.inv)} + receipts ${d2(tax.sr)} - memos ${d2(tax.cm)} + EUR ${d2(tax.fx)})`);

  // 8. P&L vs equity: net income over the whole window = unclosed earnings on the balance sheet;
  //    and at a random cutoff D, P&L(start..D) + P&L(D+1..end) = whole, BS(D).RE = P&L(start..D).
  const whole = await profitAndLoss(ctx, { from: WINDOW_START, to: FAR });
  const bsEnd = await balanceSheet(ctx, FAR);
  if (!Money.eq(whole.netIncome, bsEnd.retainedEarnings)) bad('pl-bs', `P&L net income ${whole.netIncome} != BS earnings ${bsEnd.retainedEarnings}`);
  const D = r.day();
  const D1 = new Date(Date.UTC(D.getUTCFullYear(), D.getUTCMonth(), D.getUTCDate() + 1));
  const plA = await profitAndLoss(ctx, { from: WINDOW_START, to: D });
  const plB = await profitAndLoss(ctx, { from: D1, to: FAR });
  if (!Money.eq(Money.add(plA.netIncome, plB.netIncome), whole.netIncome)) bad('pl-split', `P&L split at ${D.toISOString().slice(0, 10)}: ${plA.netIncome} + ${plB.netIncome} != ${whole.netIncome}`);
  const bsD = await balanceSheet(ctx, D);
  if (!Money.eq(bsD.retainedEarnings, plA.netIncome)) bad('pl-bs', `BS(${D.toISOString().slice(0, 10)}) earnings ${bsD.retainedEarnings} != P&L to date ${plA.netIncome}`);

  // 9. As-of cutoff: agings and Undeposited Funds tie to the GL as of D.
  const glD = await glByCode(w, D);
  const gd = (code: string) => glD.get(code) ?? Money.zero();
  const arD = await arAging(ctx, D);
  if (!Money.eq(arD.totals.total, gd('1200'))) bad('ar-asof', `A/R aging as of ${D.toISOString().slice(0, 10)} ${arD.totals.total} != GL 1200 ${d2(gd('1200'))}`);
  const apD = await apAging(ctx, D);
  if (!Money.eq(apD.totals.total, gd('2000').negated())) bad('ap-asof', `A/P aging as of ${D.toISOString().slice(0, 10)} ${apD.totals.total} != GL 2000 ${d2(gd('2000').negated())}`);
  const undD = await listUndepositedPayments(ctx, { asOf: new Date(D1.getTime() - 1) });
  let ufD = Money.zero();
  for (const u of undD) {
    if (!u.currency) ufD = ufD.plus(Money.of(u.amount));
    else {
      ufD = ufD.plus(await postedUfHome(w, u));
    }
  }
  if (!Money.eq(ufD, gd('1050'))) bad('uf-asof', `Undeposited Funds as of ${D.toISOString().slice(0, 10)}: GL ${d2(gd('1050'))} != items ${d2(ufD)}`);
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type Step = [op: string, seed: number];

export interface Failure {
  step: number;
  op: string;
  kind: 'exception' | 'invariant';
  ids: string[];
  detail: string;
}

export function isExpected(err: unknown): boolean {
  if (!(err instanceof ServiceError)) return false;
  if (err.code === 'INTERNAL' || err.code === 'UNBALANCED') return false;
  const sqlstate = (err.details as { sqlstate?: string } | undefined)?.sqlstate;
  if (sqlstate) return false;
  return true;
}

/** FUZZ_EXCLUDE="opA,opB": leave those operations out of generated runs. */
const EXCLUDE = new Set((process.env.FUZZ_EXCLUDE ?? '').split(',').map((x) => x.trim()).filter(Boolean));

export function generate(seed: number, n: number): Step[] {
  const r = new R(seed);
  const weight = (k: string) => (EXCLUDE.has(k) ? 0 : OPS[k][0]);
  const total = OP_NAMES.reduce((a, k) => a + weight(k), 0);
  const steps: Step[] = [];
  for (let i = 0; i < n; i++) {
    let x = r.f() * total;
    let name = OP_NAMES[0];
    for (const k of OP_NAMES) {
      if (!weight(k)) continue;
      if ((x -= weight(k)) < 0) {
        name = k;
        break;
      }
    }
    steps.push([name, mixSeed(seed, i)]);
  }
  return steps;
}

export interface RunStats {
  ok: Record<string, number>;
  rejected: Record<string, number>;
  skipped: Record<string, number>;
  rejections: Record<string, number>;
  checks: number;
}

export async function runSteps(
  db: DB,
  userId: string,
  steps: Step[],
  opts: { checkEvery: number; tag: string; soft?: Set<string>; only?: Set<string>; debug?: boolean },
): Promise<{ failure?: Failure; stats: RunStats; warnings: string[]; world?: World }> {
  const w = await setupWorld(db, userId, opts.tag);
  const stats: RunStats = { ok: {}, rejected: {}, skipped: {}, rejections: {}, checks: 0 };
  const warnings: string[] = [];
  const check = async (i: number, op: string): Promise<Failure | undefined> => {
    stats.checks++;
    const v = await checkInvariants(w, new R(mixSeed(steps[Math.max(0, i - 1)]?.[1] ?? 7, 99)));
    const hard = v.filter((x) => !opts.soft?.has(x.id) && (!opts.only || opts.only.has(x.id)));
    for (const x of v) if (!hard.includes(x)) warnings.push(`step ${i} ${x.id}: ${x.msg}`);
    if (hard.length) {
      return { step: i, op, kind: 'invariant', ids: [...new Set(hard.map((x) => x.id))], detail: hard.map((x) => `[${x.id}] ${x.msg}`).join('\n') };
    }
    return undefined;
  };
  for (let i = 0; i < steps.length; i++) {
    const [op, s] = steps[i];
    const fn = OPS[op]?.[1];
    if (!fn) throw new Error(`unknown op ${op}`);
    try {
      const res = await fn(w, new R(s));
      if (res === SKIP) stats.skipped[op] = (stats.skipped[op] ?? 0) + 1;
      else stats.ok[op] = (stats.ok[op] ?? 0) + 1;
      if (opts.debug) console.log(`#${i} ${op}@${s} ${res === SKIP ? 'skip' : 'ok'}`);
    } catch (err) {
      if (!isExpected(err)) {
        return {
          failure: { step: i, op, kind: 'exception', ids: ['exception'], detail: `${op}@${s}: ${(err as Error)?.stack ?? err}` },
          stats,
          warnings,
          world: w,
        };
      }
      stats.rejected[op] = (stats.rejected[op] ?? 0) + 1;
      const key = `${op}: ${(err as Error).message.slice(0, 90)}`;
      stats.rejections[key] = (stats.rejections[key] ?? 0) + 1;
      if (opts.debug) console.log(`#${i} ${op}@${s} rejected: ${(err as Error).message}`);
    }
    if ((i + 1) % opts.checkEvery === 0 || i === steps.length - 1) {
      const f = await check(i, op);
      if (f) return { failure: f, stats, warnings, world: w };
    }
  }
  return { stats, warnings, world: w };
}

/** ddmin-style shrinking: remove chunks while the same invariant id still fails. */
export async function minimize(db: DB, userId: string, steps: Step[], target: string[], tag: string): Promise<Step[]> {
  const fails = async (s: Step[]) => {
    if (!s.length) return false;
    const { failure } = await runSteps(db, userId, s, { checkEvery: 1_000_000, tag });
    return !!failure && failure.ids.some((id) => target.includes(id));
  };
  let cur = steps;
  let n = 2;
  while (cur.length >= 2) {
    const chunk = Math.ceil(cur.length / n);
    let reduced = false;
    for (let i = 0; i < cur.length; i += chunk) {
      const cand = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      if (await fails(cand)) {
        cur = cand;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= cur.length) break;
      n = Math.min(cur.length, n * 2);
    }
  }
  return cur;
}

/** FUZZ_DUMP: print the documents of a replayed company (dates, amounts, links) for diagnosis. */
export async function dumpWorld(w: World): Promise<void> {
  const c = w.ctx.companyId;
  const q = async (label: string, query: ReturnType<typeof sql>) => {
    const r = await rows(w, query);
    if (r.length) console.log(`--- ${label}\n${r.map((x) => JSON.stringify(x, (_k, v) => (v instanceof Date ? v.toISOString().slice(0, 16) : v))).join('\n')}`);
  };
  await q('invoices', sql`SELECT id, customer_id, date, status, currency, exchange_rate, subtotal, discount, tax_amount, total, amount_paid, balance_due, retainage_amount FROM invoices WHERE company_id = ${c} ORDER BY created_at`);
  await q('invoice lines', sql`SELECT l.invoice_id, l.item_id, l.account_id, l.quantity, l.rate, l.amount FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.company_id = ${c} ORDER BY i.created_at, l.line_order`);
  await q('payments', sql`SELECT id, customer_id, date, amount, unapplied, currency, exchange_rate, deposit_account_id, voided_at, bounced_at FROM payments_received WHERE company_id = ${c} ORDER BY created_at`);
  await q('payment applications', sql`SELECT a.* FROM payment_applications a JOIN payments_received p ON p.id = a.payment_id WHERE p.company_id = ${c}`);
  await q('credit memos', sql`SELECT id, customer_id, date, status, total, unapplied, refunded_amount FROM credit_memos WHERE company_id = ${c} ORDER BY created_at`);
  await q('credit applications', sql`SELECT * FROM credit_applications WHERE company_id = ${c}`);
  await q('bills', sql`SELECT id, vendor_id, date, status, currency, exchange_rate, total, amount_paid, amount_credited, balance_due FROM bills WHERE company_id = ${c} ORDER BY created_at`);
  await q('bill lines', sql`SELECT l.bill_id, l.item_id, l.account_id, l.quantity, l.amount FROM bill_lines l JOIN bills b ON b.id = l.bill_id WHERE b.company_id = ${c}`);
  await q('vendor credits', sql`SELECT id, vendor_id, date, status, total, unapplied, currency FROM vendor_credits WHERE company_id = ${c} ORDER BY created_at`);
  await q('deposits', sql`SELECT id, date, total, deposit_account_id, voided_at FROM deposits WHERE company_id = ${c} ORDER BY created_at`);
  await q('items', sql`SELECT name, quantity_on_hand, average_cost FROM items WHERE company_id = ${c} AND type = 'inventory' ORDER BY name`);
  await q('layers', sql`SELECT i.name, l.date, l.quantity_remaining, l.unit_cost, l.source_ref FROM inventory_layers l JOIN items i ON i.id = l.item_id WHERE l.company_id = ${c} ORDER BY i.name, l.date, l.created_at`);
  await q('entries', sql`SELECT e.entry_number, e.date, e.status, e.source_ref, e.reference, a.code, l.debit, l.credit, l.entity_id
      FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = ${c} AND (e.source_ref IS NULL OR e.source_ref NOT LIKE 'item:%' OR e.date > '2026-01-01') ORDER BY e.entry_number, a.code`);
}

function parseSeeds(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
    else out.push(Number(part));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

const SEEDS = parseSeeds(process.env.FUZZ_SEEDS ?? '4101-4104');
const N_OPS = Number(process.env.FUZZ_OPS ?? 200);
const CHECK_EVERY = Number(process.env.FUZZ_CHECK ?? 30);
// Every invariant is hard by default (FUZZ_SOFT="id,id" turns some into warnings while hunting).
const SOFT = new Set((process.env.FUZZ_SOFT ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const REPLAY = process.env.FUZZ_REPLAY;

let db: DB;
let userId: string;

describe('review4 invariant fuzzer', () => {
  beforeAll(async () => {
    if (!process.env.FUZZ_KEEP_DIR) fs.rmSync(FUZZ_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(FUZZ_DIR);
    const [u] = await db.insert(users).values({ email: `fuzz-${Date.now()}@test.local`, name: 'Fuzz', passwordHash: 'x' }).returning();
    userId = u.id;
  }, 120_000);
  afterAll(async () => {
    await closeDb(FUZZ_DIR);
    try {
      fs.rmSync(FUZZ_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  if (REPLAY) {
    it('replays FUZZ_REPLAY', async () => {
      const steps: Step[] = REPLAY.split(/\s+/).filter(Boolean).map((t) => {
        const [op, s] = t.split('@');
        return [op, Number(s)];
      });
      const { failure, stats, warnings, world } = await runSteps(db, userId, steps, { checkEvery: Number(process.env.FUZZ_CHECK ?? 1), tag: 'replay', soft: SOFT, debug: true });
      if (process.env.FUZZ_DUMP && world) await dumpWorld(world);
      if (warnings.length) console.log(`warnings:\n${warnings.join('\n')}`);
      console.log(JSON.stringify(stats.rejections, null, 1));
      expect(failure?.detail ?? 'ok').toBe('ok');
    }, 600_000);
    return;
  }

  for (const seed of SEEDS) {
    it(`seed ${seed}: ${N_OPS} random operations keep every cross-module invariant`, async () => {
      const t0 = Date.now();
      const steps = generate(seed, N_OPS);
      const { failure, stats, warnings } = await runSteps(db, userId, steps, { checkEvery: CHECK_EVERY, tag: `s${seed}`, soft: SOFT, debug: !!process.env.FUZZ_DEBUG });
      if (process.env.FUZZ_STATS) {
        console.log(`seed ${seed} (${Date.now() - t0}ms, ${stats.checks} checks) ok=${JSON.stringify(stats.ok)}\nrejected=${JSON.stringify(stats.rejected)}\nskipped=${JSON.stringify(stats.skipped)}`);
        console.log(JSON.stringify(stats.rejections, null, 1));
      }
      if (warnings.length) console.log(`seed ${seed} warnings:\n${warnings.slice(0, 20).join('\n')}`);
      if (failure) {
        const upTo = steps.slice(0, failure.step + 1);
        let msg = `seed ${seed} step ${failure.step} (${failure.op}) ${failure.kind}:\n${failure.detail}\nreplay: FUZZ_REPLAY="${upTo.map(([o, s]) => `${o}@${s}`).join(' ')}"`;
        if (process.env.FUZZ_MIN) {
          const small = await minimize(db, userId, upTo, failure.ids, `min${seed}`);
          msg += `\nminimal (${small.length} steps): FUZZ_REPLAY="${small.map(([o, s]) => `${o}@${s}`).join(' ')}"`;
        }
        console.log(msg);
        expect.fail(msg);
      }
      // The run must exercise the ledger, not just bounce off validation.
      const okCount = Object.values(stats.ok).reduce((a, b) => a + b, 0);
      expect(okCount).toBeGreaterThan(N_OPS * 0.4);
    }, 900_000);
  }
});
