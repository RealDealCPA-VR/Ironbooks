/**
 * Accountant's Copy (PARITY I1): inventory is costed on import as the ACCOUNTANT's file costed it.
 *
 * The client buys more stock at a higher cost after the dividing date while the copy is out. The
 * accountant's sales (invoice, sales receipt), credit memo restock, quantity removal and the edit
 * of an existing inventory invoice are costed in the copy at the copy's average cost; re-applied
 * through the client's services at the client's CURRENT average cost they would cost more and change
 * the period the accountant closed. The changes file carries each line's cost and the import uses it:
 *  - the client's trial balance AT THE DIVIDING DATE equals the accountant's;
 *  - the full trial balance equals a REFERENCE company file where the same work was entered in date
 *    order (an independent expectation), and so do the item's quantity and value.
 * Also: estimate lines made in the copy and billed by an invoice made there map to the client's new
 * estimate lines; a reconciliation left in progress in the copy is reported (it can't travel).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, estimateLines, estimates, invoiceLines, invoices, items, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createBankAccount } from '../bankAccounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createItem } from '../items';
import { createBill } from '../bills';
import { createInvoice, updateInvoice } from '../invoices';
import { createSalesReceipt } from '../salesReceipts';
import { createCreditMemo } from '../creditMemos';
import { adjustQuantityAtSite } from '../inventorySiteOps';
import { createEstimate, getEstimate } from '../estimates';
import { createManualEntry } from '../journal';
import { startReconciliation } from '../reconcile';
import { trialBalance } from '../reports';
import { createAccountantCopy, importChangesFile, reviewChangesFile } from './client';
import { accountantChanges, exportChangesFile, openAccountantCopyFile } from './accountant';
import { parseChangesFile, serializeChangesFile } from './format';
import { averageAfter } from './inventoryCost';
import Decimal from 'decimal.js';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-costs');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const REF_DIR = path.join(ROOT, 'reference');

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const endOfDay = (s: string) => new Date(`${s}T23:59:59.999Z`);
const DIVIDING = '2026-03-31';

type Refs = Record<string, string>;

async function newCompany(dir: string, email: string): Promise<{ ctx: ServiceContext; db: DB; acct: Refs }> {
  const db = await getDb(dir);
  const [user] = await db.insert(users).values({ email, name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Widget Co', ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const acct: Refs = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, db, acct };
}

/** 10 Widgets at $10, one February sale of 2. */
async function clientSetup(ctx: ServiceContext, acct: Refs): Promise<Refs> {
  const R: Refs = {};
  R.acme = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
  R.supplier = (await createVendor(ctx, { displayName: 'Supplier Co' })).id;
  R.widget = (
    await createItem(ctx, { name: 'Widget', type: 'inventory', assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'], purchaseCost: '10' })
  ).id;
  R.bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '987654321' })).id;
  await createManualEntry(ctx, { date: d('2026-01-02'), description: 'Owner investment', lines: [{ accountId: acct['1000'], debit: '5000.00' }, { accountId: acct['3000'], credit: '5000.00' }] });
  R.billA = (await createBill(ctx, { vendorId: R.supplier, date: d('2026-01-15'), lines: [{ itemId: R.widget, quantity: 10, unitCost: '10' }] })).id;
  R.invI = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-10'), lines: [{ itemId: R.widget, quantity: 2, rate: '25' }] })).id;
  return R;
}

/** The accountant's inventory work (all on or before the dividing date). */
async function accountantWork(ctx: ServiceContext, acct: Refs, R: Refs): Promise<Refs> {
  const N: Refs = {};
  N.inv = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-03-10'), refNumber: 'AC-10', lines: [{ itemId: R.widget, quantity: 2, rate: '30' }] })).id;
  N.sr = (
    await createSalesReceipt(ctx, { customerId: R.acme, date: d('2026-03-11'), refNumber: 'SR-10', lines: [{ itemId: R.widget, quantity: 1, rate: '30' }], depositAccountId: acct['1050'] })
  ).id;
  N.cm = (await createCreditMemo(ctx, { customerId: R.acme, date: d('2026-03-12'), refNumber: 'CM-10', lines: [{ itemId: R.widget, quantity: 1, rate: '30', restock: true }] })).id;
  await adjustQuantityAtSite(ctx, { itemId: R.widget, quantityChange: '-1', date: d('2026-03-15'), memo: 'Broken', adjustmentAccountId: acct['6300'] });
  // Re-posts the February invoice's COGS (edit of an existing inventory invoice).
  await updateInvoice(ctx, R.invI, { customerId: R.acme, date: d('2026-02-10'), lines: [{ itemId: R.widget, quantity: 2, rate: '27' }] });
  // An estimate made here, and an invoice line billing one of its lines.
  N.est = (await createEstimate(ctx, { customerId: R.acme, date: d('2026-03-20'), lines: [{ description: 'Install', quantity: 4, rate: '50' }, { description: 'Travel', quantity: 1, rate: '40' }] })).id;
  const est = await getEstimate(ctx, N.est);
  N.estInv = (
    await createInvoice(ctx, { customerId: R.acme, date: d('2026-03-22'), refNumber: 'AC-11', lines: [{ estimateLineId: est.lines[0].id, description: 'Install', quantity: 2, rate: '50' }] })
  ).id;
  return N;
}

/** The client buys 10 more at $20 after the dividing date. */
async function clientLater(ctx: ServiceContext, R: Refs) {
  await createBill(ctx, { vendorId: R.supplier, date: d('2026-04-05'), lines: [{ itemId: R.widget, quantity: 10, unitCost: '20' }] });
}

async function tbByCode(c: ServiceContext, asOf?: Date) {
  const tb = await trialBalance(c, asOf);
  return Object.fromEntries(tb.rows.filter((r) => Number(r.debit) !== 0 || Number(r.credit) !== 0).map((r) => [r.code, `${r.debit}/${r.credit}`]));
}

async function widgetValue(c: ServiceContext, id: string) {
  const [w] = await c.db.select().from(items).where(and(eq(items.companyId, c.companyId), eq(items.id, id)));
  return { qty: Money.of(w.quantityOnHand ?? '0').toFixed(4), value: Money.round2(Money.of(w.quantityOnHand ?? '0').times(Money.of(w.averageCost ?? '0'))).toFixed(2) };
}

let client: { ctx: ServiceContext; db: DB; acct: Refs };
let reference: { ctx: ServiceContext; db: DB; acct: Refs };
let actx: ServiceContext;
let R: Refs;
let RR: Refs;
let N: Refs;
let changes: Buffer;
let accountantTbAtDividing: Record<string, string>;

describe("Accountant's Copy — inventory costed as in the accountant's file", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    client = await newCompany(CLIENT_DIR, 'client-costs@test.local');
    R = await clientSetup(client.ctx, client.acct);
    reference = await newCompany(REF_DIR, 'ref-costs@test.local');
    RR = await clientSetup(reference.ctx, reference.acct);
    await accountantWork(reference.ctx, reference.acct, RR);
    await clientLater(reference.ctx, RR);
  }, 120_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR, REF_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('accountant: sales, restock, removal and the re-posted invoice carry the copy’s cost; an unfinished reconciliation is reported', async () => {
    const transfer = (await createAccountantCopy(client.ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR })).buffer;
    await clientLater(client.ctx, R);
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: client.ctx.companyId, userId: client.ctx.userId };
    N = await accountantWork(actx, client.acct, R);
    // Started, never finished.
    await startReconciliation(actx, { bankAccountId: R.bank, statementDate: d('2026-03-31'), statementBalance: '5000.00' });

    const c = await accountantChanges(actx);
    expect(c.reconciliations).toEqual([]);
    expect(c.warnings.join(' ')).toMatch(/statement ending 2026-03-31 is still in progress in this copy.*cleared marks/);
    const doc = (id: string) => c.documents.find((x) => x.id === id) as unknown as { after: { lines: Array<{ cost?: string }>; total?: string; unitCost?: string } };
    expect(doc(N.inv).after.lines.map((l) => l.cost)).toEqual(['20.00']);
    expect(doc(N.sr).after.lines.map((l) => l.cost)).toEqual(['10.00']);
    expect(doc(N.cm).after.lines.map((l) => l.cost)).toEqual(['10.00']);
    expect(doc(R.invI).after.lines.map((l) => l.cost)).toEqual(['20.00']);
    const adj = c.documents.find((x) => x.type === 'inventory_adjustment') as unknown as { after: { total: string; unitCost: string } };
    expect(adj.after).toMatchObject({ total: '10.00', unitCost: '10' });
    // The estimate's lines travel with their ids (the new invoice bills one of them).
    const est = c.documents.find((x) => x.id === N.est) as unknown as { after: { lines: Array<{ id?: string }> } };
    expect(est.after.lines.every((l) => typeof l.id === 'string')).toBe(true);

    accountantTbAtDividing = await tbByCode(actx, endOfDay(DIVIDING));
    changes = (await exportChangesFile(actx, {})).buffer;
    expect(parseChangesFile(changes).warnings.join(' ')).toMatch(/still in progress/);
  });

  it('client: the review shows the accountant’s cost and what the client’s current average would have made it', async () => {
    const review = await reviewChangesFile(client.ctx, changes);
    expect(review.canImport).toBe(true);
    expect(review.warnings.join(' ')).toMatch(/still in progress/);
    const inv = review.items.find((i) => i.key === `invoice:add:${N.inv}`)!;
    expect(inv.after?.join(' ')).toMatch(/cost of goods \$20\.00/);
    // Client now: 18 Widgets worth $280 (8 at $10 + 10 at $20) → average $15.5556.
    expect(inv.note).toMatch(/Inventory cost \$20\.00 is kept from your accountant's file \(your current average cost would make it \$31\.11\)/);
    expect(review.items.find((i) => i.key === `credit_memo:add:${N.cm}`)?.after?.join(' ')).toMatch(/restocked at \$10\.00/);
  });

  it('client: a tampered inventory cost is refused before anything is applied, naming the change', async () => {
    const { sha256: _s, ...body } = parseChangesFile(changes);
    type Line = { cost?: string; restock?: boolean; itemId?: string | null };
    const docAfter = (b: typeof body, id: string) => (b.documents.find((x) => x.id === id) as unknown as { after: { lines: Line[]; total: string } }).after;
    const tamper = (mutate: (b: typeof body) => void) => {
      const copy = JSON.parse(JSON.stringify(body)) as typeof body;
      mutate(copy);
      return serializeChangesFile(copy);
    };
    const parseCases: Array<[Buffer, RegExp]> = [
      // A negative restock cost (it skipped the GL entry yet moved the item's average and value).
      [tamper((b) => { docAfter(b, N.cm).lines[0].cost = '-50.00'; }), /line 1 of the new credit memo #CM-10 dated 2026-03-12 has a negative inventory cost \(-50\.00\)/],
      [tamper((b) => { docAfter(b, N.inv).lines[0].cost = '-0.01'; }), /line 1 of the new invoice #AC-10 dated 2026-03-10 has a negative inventory cost/],
      // A negative removal value.
      [
        tamper((b) => { (b.documents.find((x) => x.type === 'inventory_adjustment') as unknown as { after: { total: string } }).after.total = '-10.00'; }),
        /the new inventory adjustment dated 2026-03-15 has a negative value \(-10\.00\)/,
      ],
      // A cost on a credit memo line that does not restock, and on a line without an item.
      [tamper((b) => { docAfter(b, N.cm).lines[0].restock = false; }), /line 1 of the new credit memo #CM-10 .* does not restock the item/],
      [tamper((b) => { docAfter(b, N.estInv).lines[0].cost = '5.00'; }), /line 1 of the new invoice #AC-11 .* carries an inventory cost but no item/],
    ];
    for (const [file, message] of parseCases) {
      await expect(reviewChangesFile(client.ctx, file)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(message) });
      await expect(importChangesFile(client.ctx, file)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(message) });
    }

    // Well-formed but more than the client's whole stock is worth: refused on import (inside the
    // transaction) instead of clamping the item's average to 0; nothing is applied.
    const before = await tbByCode(client.ctx);
    const huge = tamper((b) => { docAfter(b, N.sr).lines[0].cost = '100000.00'; });
    await expect(importChangesFile(client.ctx, huge)).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/SR-10[\s\S]*more than the value of the item's stock in your file[\s\S]*below zero/),
    });
    expect(await tbByCode(client.ctx)).toEqual(before);
    expect(await widgetValue(client.ctx, R.widget)).toEqual({ qty: '18.0000', value: '280.00' });
  });

  it('averageAfter refuses a value below zero (no clamping) and tolerates cent rounding', () => {
    const D = (v: string) => new Decimal(v);
    expect(() => averageAfter(D('2'), D('10'), D('1'), D('-25'))).toThrow(/below zero/);
    expect(() => averageAfter(D('2'), D('10'), D('0'), D('-25'))).toThrow(/below zero/);
    expect(averageAfter(D('3'), D('3.3333'), D('0'), D('-10.00')).toString()).toBe('3.3333');
    expect(averageAfter(D('2'), D('10'), D('1'), D('-12')).toString()).toBe('8');
  });

  it('client: after the import the dividing-date trial balance equals the accountant’s, and everything equals the reference', async () => {
    const res = await importChangesFile(client.ctx, changes);
    expect(res.trialBalance.balanced).toBe(true);
    expect(await tbByCode(client.ctx, endOfDay(DIVIDING))).toEqual(accountantTbAtDividing);
    expect(await tbByCode(client.ctx)).toEqual(await tbByCode(reference.ctx));
    expect(await tbByCode(client.ctx, endOfDay(DIVIDING))).toEqual(await tbByCode(reference.ctx, endOfDay(DIVIDING)));
    // By hand: COGS = 20 (Feb, re-posted) + 20 + 10 - 10 (restock) = 40; Inventory = 100 + 200 - 40 - 10 (removal) = 250.
    const tb = await trialBalance(client.ctx);
    expect(tb.rows.find((r) => r.code === '5000')?.debit).toBe('40.00');
    expect(tb.rows.find((r) => r.code === '1300')?.debit).toBe('250.00');
    // The item's quantity and value agree with the reference and with the ledger.
    expect(await widgetValue(client.ctx, R.widget)).toEqual(await widgetValue(reference.ctx, RR.widget));
    expect(await widgetValue(client.ctx, R.widget)).toEqual({ qty: '15.0000', value: '250.00' });
  });

  it('client: the invoice made in the copy bills the client’s copy of the estimate line made there', async () => {
    const { db, ctx } = client;
    const [inv] = await db.select().from(invoices).where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.refNumber, 'AC-11')));
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const [est] = await db.select().from(estimates).where(and(eq(estimates.companyId, ctx.companyId), eq(estimates.total, '240.00')));
    expect(est.id).not.toBe(N.est);
    const [estLine] = await db.select().from(estimateLines).where(eq(estimateLines.id, line.estimateLineId!));
    expect(estLine.estimateId).toBe(est.id);
    expect(estLine.description).toBe('Install');
  });
});
