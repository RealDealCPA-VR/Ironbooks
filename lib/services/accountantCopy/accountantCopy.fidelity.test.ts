/**
 * Accountant's Copy (PARITY I1) — fidelity of the changes file:
 *  - one General Journal line referenced by several changes (a credit split across two invoices,
 *    a charge paid by two partial payments whose deposits look alike and are both reconciled);
 *  - billable time and costs can't be billed in the copy (the links could not travel);
 *  - every name / item field the copy can change travels: custom fields, customer type, reorder
 *    point, and for new names price level and ship-to addresses;
 *  - invoice percent discounts and progress-invoicing links survive an edit;
 *  - record locking per field (both sides editing different fields of one name), and "keep mine";
 *  - an inventory adjustment (or a form's entry) can't be voided from the journal in the copy.
 * The client's trial balance after the import must equal a reference file where the same work
 * was done directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, billLines, customers, invoiceLines, invoices, items, journalEntryLines, journalItemApplications, paymentsReceived, reconciliations, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createBankAccount } from '../bankAccounts';
import { createCustomer, updateCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createItem } from '../items';
import { createInvoice, getInvoice, updateInvoice } from '../invoices';
import { receivePayment } from '../payments';
import { createBill } from '../bills';
import { createEstimate, getEstimate, updateEstimateStatus } from '../estimates';
import { createManualEntry, voidEntry } from '../journal';
import { applyJournalCredit } from '../journalApplications';
import { completeReconciliation, listClearable, startReconciliation, toggleCleared } from '../reconcile';
import { adjustQuantityAtSite } from '../inventorySiteOps';
import { createInvoiceWithBillables } from '../billables';
import { billTimeToInvoice, createTimeEntry } from '../timeTracking';
import { setCustomFieldDefinitions, setEntityCustomFields } from '../customFields';
import { assignCustomerPricing, createPriceLevel } from '../pricing';
import { createType } from '../typeLists';
import { setReorderPoint } from '../inventory';
import { trialBalance } from '../reports';
import { createAccountantCopy, importChangesFile, reviewChangesFile } from './client';
import { accountantChanges, exportChangesFile, openAccountantCopyFile } from './accountant';
import { discountPercentOf } from './docs';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-fidelity');
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
  const company = await createCompany(db, { name: 'Fidelity Co', ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const acct: Refs = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, db, acct };
}

async function arLine(ctx: ServiceContext, entryId: string, acct: Refs) {
  const [l] = await ctx.db.select().from(journalEntryLines).where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, acct['1200'])));
  return l.id;
}

/** The client's books when the copy is made (also the reference's start). */
async function setup(ctx: ServiceContext, acct: Refs): Promise<Refs> {
  const R: Refs = {};
  await setCustomFieldDefinitions(ctx, { customer: [{ name: 'Region' }], vendor: [{ name: 'Rep' }], item: [{ name: 'Bin' }] });
  R.retail = (await createType(ctx, 'customer', { name: 'Retail' })).id;
  R.wholesale = (await createType(ctx, 'customer', { name: 'Wholesale' })).id;
  R.gold = (await createPriceLevel(ctx, { name: 'Gold', type: 'fixed_percent', percent: -10 })).id;
  R.acme = (await createCustomer(ctx, { displayName: 'Acme', phone: '555-0001' })).id;
  R.beta = (await createCustomer(ctx, { displayName: 'Beta', email: 'beta@old.test' })).id;
  R.supplier = (await createVendor(ctx, { displayName: 'Supplier' })).id;
  R.consulting = (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: '100', incomeAccountId: acct['4100'] })).id;
  R.widget = (
    await createItem(ctx, { name: 'Widget', type: 'inventory', assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'], purchaseCost: '10' })
  ).id;
  R.bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'Bank', accountNumber: '111222333' })).id;
  await createManualEntry(ctx, { date: d('2026-01-02'), description: 'Investment', lines: [{ accountId: acct['1000'], debit: '1000.00' }, { accountId: acct['3000'], credit: '1000.00' }] });
  R.inv1 = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-01'), refNumber: 'I-1', lines: [{ description: 'One', quantity: 1, rate: '300', accountId: acct['4100'] }] })).id;
  R.inv2 = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-02'), refNumber: 'I-2', lines: [{ description: 'Two', quantity: 1, rate: '200', accountId: acct['4100'] }] })).id;
  // A General Journal A/R credit (Acme, 100) and an A/R charge (Beta, 80).
  R.jeCredit = (
    await createManualEntry(ctx, {
      date: d('2026-02-10'),
      description: 'Credit for delays',
      lines: [{ accountId: acct['6000'], debit: '100.00' }, { accountId: acct['1200'], credit: '100.00', entityType: 'customer', entityId: R.acme }],
    })
  ).id;
  R.jeCharge = (
    await createManualEntry(ctx, {
      date: d('2026-02-11'),
      description: 'Rebilled freight',
      lines: [{ accountId: acct['1200'], debit: '80.00', entityType: 'customer', entityId: R.beta }, { accountId: acct['4100'], credit: '80.00' }],
    })
  ).id;
  // An invoice with a 10% discount, and one billing an estimate line (progress invoicing link).
  R.invD = (
    await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-15'), refNumber: 'I-D', discount: '10', discountType: 'percent', lines: [{ description: 'Discounted', quantity: 1, rate: '333.33', accountId: acct['4100'] }] })
  ).id;
  R.est = (await createEstimate(ctx, { customerId: R.acme, date: d('2026-02-03'), lines: [{ itemId: R.consulting, description: 'Plan', quantity: 10, rate: '100' }] })).id;
  await updateEstimateStatus(ctx, R.est, 'accepted');
  const est = await getEstimate(ctx, R.est);
  R.estLine = est.lines[0].id;
  R.invE = (
    await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-20'), refNumber: 'I-E', lines: [{ itemId: R.consulting, description: 'Plan', quantity: 2, rate: '100', estimateLineId: R.estLine }] })
  ).id;
  // A bill with a cost billable to Acme, and billable time.
  R.billX = (await createBill(ctx, { vendorId: R.supplier, date: d('2026-02-05'), lines: [{ accountId: acct['6300'], amount: '50', customerId: R.acme }] })).id;
  await createTimeEntry(ctx, { customerId: R.acme, date: d('2026-02-06'), hours: 2, billable: true, rate: '75' });
  return R;
}

/** The accountant's ledger work (also done directly in the reference). */
async function ledgerWork(ctx: ServiceContext, acct: Refs, R: Refs): Promise<void> {
  // One General Journal credit split across two invoices.
  const credit = await arLine(ctx, R.jeCredit, acct);
  await applyJournalCredit(ctx, { journalLineId: credit, invoiceId: R.inv1, amount: '60', date: d('2026-03-01') });
  await applyJournalCredit(ctx, { journalLineId: credit, invoiceId: R.inv2, amount: '40', date: d('2026-03-02') });
  // One General Journal charge paid by two partial payments of the same amount, straight to Checking.
  const charge = await arLine(ctx, R.jeCharge, acct);
  for (const [ref, day] of [['P-1', '2026-03-10'], ['P-2', '2026-03-12']]) {
    await receivePayment(ctx, { customerId: R.beta, date: d(day), method: 'check', reference: ref, amount: '40', depositAccountId: acct['1000'], applications: [], journalItems: [{ journalLineId: charge, amount: '40' }] });
  }
  // Reconcile March: the investment and both (look-alike) payments.
  const mar = await startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-03-31'), statementBalance: '1080.00' });
  for (const l of await listClearable(ctx, R.bank, endOfDay('2026-03-31'), mar.id)) await toggleCleared(ctx, mar.id, l.journalEntryLineId, true);
  await completeReconciliation(ctx, mar.id);
  // Edit the discounted invoice (still 10%) and remove the estimate link of invoice E.
  await updateInvoice(ctx, R.invD, { customerId: R.acme, date: d('2026-02-15'), refNumber: 'I-D', discount: '10', discountType: 'percent', lines: [{ description: 'Discounted', quantity: 1, rate: '500', accountId: acct['4100'] }] });
  const invE = await getInvoice(ctx, R.invE);
  await updateInvoice(ctx, R.invE, {
    customerId: R.acme,
    date: d('2026-02-20'),
    refNumber: 'I-E',
    lines: invE.lines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, estimateLineId: null })),
  });
  // An inventory adjustment (it travels; voiding it from the journal does not, see below).
  await adjustQuantityAtSite(ctx, { itemId: R.widget, quantityChange: '4', unitCost: '10', date: d('2026-03-20'), adjustmentAccountId: acct['6300'] });
}

/** What the client enters after the copy is made (dated after the dividing date, plus name edits). */
async function clientLater(ctx: ServiceContext, acct: Refs, R: Refs): Promise<void> {
  await createInvoice(ctx, { customerId: R.acme, date: d('2026-04-03'), lines: [{ description: 'April', quantity: 1, rate: '90', accountId: acct['4100'] }] });
  await updateCustomer(ctx, R.acme, { email: 'acme@client.test' }); // a field the accountant does not touch
  await updateCustomer(ctx, R.beta, { email: 'beta@client.test' }); // a field the accountant changes too
}

async function tbByCode(c: ServiceContext, asOf?: Date) {
  const tb = await trialBalance(c, asOf);
  return Object.fromEntries(tb.rows.filter((r) => Number(r.debit) !== 0 || Number(r.credit) !== 0).map((r) => [r.code, `${r.debit}/${r.credit}`]));
}

let client: { ctx: ServiceContext; db: DB; acct: Refs };
let reference: { ctx: ServiceContext; db: DB; acct: Refs };
let actx: ServiceContext;
let R: Refs;
let changes: Buffer;

describe("Accountant's Copy — fidelity of the changes file", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    client = await newCompany(CLIENT_DIR, 'client-fid@test.local');
    R = await setup(client.ctx, client.acct);
    reference = await newCompany(REF_DIR, 'ref-fid@test.local');
    const RR = await setup(reference.ctx, reference.acct);
    await ledgerWork(reference.ctx, reference.acct, RR);
    await clientLater(reference.ctx, reference.acct, RR);
  }, 120_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR, REF_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('a percent discount is carried as the percent it was entered as', () => {
    expect(discountPercentOf('333.33', '33.33')).toBe('10');
    expect(discountPercentOf('10.00', '1.23')).toBe('12.3'); // 12.3% of 10 = 1.23
    expect(discountPercentOf('10.00', '1.24')).toBe('12.4');
    expect(discountPercentOf('7.00', '0.87')).toBe('12.4'); // 12.4% of 7 = 0.868 -> 0.87
    expect(discountPercentOf('0', '5')).toBeNull();
  });

  it('accountant: does the work; billing time and costs and voiding an adjustment or a form entry from the journal are refused', async () => {
    const created = await createAccountantCopy(client.ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR });
    await clientLater(client.ctx, client.acct, R);
    await openAccountantCopyFile(created.buffer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: client.ctx.companyId, userId: client.ctx.userId };
    const { acct } = client;

    // Billable time and costs: the links to the bill line / time entries can't travel back.
    const [costLine] = await actx.db.select().from(billLines).where(eq(billLines.billId, R.billX));
    await expect(
      createInvoiceWithBillables(actx, { customerId: R.acme, date: d('2026-03-05'), lines: [] }, { billLineIds: [costLine.id] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/Billable time and costs can't be added to an invoice in an Accountant's Copy/) });
    await expect(billTimeToInvoice(actx, { customerId: R.acme })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [stillUnbilled] = await actx.db.select().from(billLines).where(eq(billLines.id, costLine.id));
    expect(stillUnbilled.billedInvoiceId).toBeNull();

    await ledgerWork(actx, acct, R);

    // Voiding the adjustment's entry (or an invoice's) from the journal would not travel: refused.
    const adj = (await accountantChanges(actx)).documents.find((x) => x.type === 'inventory_adjustment')!;
    await expect(voidEntry(actx, adj.id)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/inventory adjustment can't be voided or changed/) });
    const [inv1] = await actx.db.select().from(invoices).where(eq(invoices.id, R.inv1));
    await expect(voidEntry(actx, inv1.postedEntryId!)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/posted by a form/) });

    // Name and item fields beyond the basic ones.
    await updateCustomer(actx, R.acme, { phone: '555-0002' });
    await setEntityCustomFields(actx, 'customer', R.acme, { Region: 'West' });
    await assignCustomerPricing(actx, R.acme, { customerTypeId: R.retail });
    await updateCustomer(actx, R.beta, { email: 'beta@accountant.test', phone: '555-0003' });
    await setReorderPoint(actx, R.widget, 5);
    await setEntityCustomFields(actx, 'item', R.widget, { Bin: 'A1' });
    const gamma = await createCustomer(actx, {
      displayName: 'Gamma',
      priceLevelId: R.gold,
      shipToAddresses: [{ name: 'Dock', line1: '1 Pier', city: 'Harbor', isDefault: true }],
    });
    await setEntityCustomFields(actx, 'customer', gamma.id, { Region: 'East' });
    await assignCustomerPricing(actx, gamma.id, { customerTypeId: R.wholesale });
    const gizmo = await createItem(actx, { name: 'Gizmo', type: 'inventory', assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'] });
    await setReorderPoint(actx, gizmo.id, 3);
    await setEntityCustomFields(actx, 'item', gizmo.id, { Bin: 'B2' });

    const c = await accountantChanges(actx);
    expect(c.warnings).toEqual([]);
    const acmeEdit = c.names.find((n) => n.op === 'edit' && n.id === R.acme);
    expect(acmeEdit && acmeEdit.op === 'edit' ? [...(acmeEdit.fields ?? [])].sort() : null).toEqual(['customFields', 'customerTypeId', 'phone']);
    const widgetEdit = c.names.find((n) => n.op === 'edit' && n.id === R.widget);
    expect(widgetEdit && widgetEdit.op === 'edit' ? [...(widgetEdit.fields ?? [])].sort() : null).toEqual(['customFields', 'reorderPoint']);
    expect(c.names.find((n) => n.op === 'add' && n.id === gamma.id)?.after).toMatchObject({
      priceLevelId: R.gold,
      customerTypeId: R.wholesale,
      customFields: { Region: 'East' },
      shipToAddresses: [{ name: 'Dock', line1: '1 Pier', city: 'Harbor', isDefault: true }],
    });
    // The split credit and the two partial payments name the same accountant journal lines.
    expect(c.applications.filter((a) => a.kind === 'journal' && a.op === 'apply')).toHaveLength(2);
    const invD = c.documents.find((x) => x.id === R.invD && x.op === 'edit');
    expect(invD && invD.op === 'edit' ? invD.after : null).toMatchObject({ discount: '10', discountType: 'percent' });
    const invE = c.documents.find((x) => x.id === R.invE && x.op === 'edit');
    expect(invE && invE.op === 'edit' ? (invE.after.lines as Array<{ estimateLineId: unknown }>)[0].estimateLineId : 'missing').toBeNull();
    changes = (await exportChangesFile(actx, {})).buffer;
  });

  it('client: the review shows the field-level conflict, the discount and the new fields; the import needs "keep mine" for it', async () => {
    const review = await reviewChangesFile(client.ctx, changes);
    const byKey = (k: string) => review.items.find((i) => i.key === k)!;
    // Acme: the client changed the email, the accountant other fields -> no conflict.
    expect(byKey(`customer:edit:${R.acme}`).problem).toBeNull();
    expect(byKey(`customer:edit:${R.acme}`).after).toContain('phone: 555-0001 → 555-0002');
    expect(byKey(`customer:edit:${R.acme}`).after?.join(' ')).not.toMatch(/email/);
    // Beta: both changed the email.
    expect(byKey(`customer:edit:${R.beta}`)).toMatchObject({ keepable: true, conflictFields: ['email'] });
    expect(review.canImport).toBe(false);
    expect(review.canImportKeepingMine).toBe(true);
    expect(byKey(`invoice:edit:${R.invD}`).after?.join(' ')).toMatch(/Discount 10%/);
    expect(byKey(`invoice:edit:${R.invE}`).before?.join(' ')).toMatch(/bills an estimate line/);
    expect(byKey(`invoice:edit:${R.invE}`).after?.join(' ')).not.toMatch(/bills an estimate line/);

    await expect(importChangesFile(client.ctx, changes)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/^Could not import the change to customer Beta: You also changed this customer's email/),
    });
  });

  it('client: imports keeping its own email; split credits, partial payments and their reconciliation resolve', async () => {
    const { ctx, db, acct } = client;
    const res = await importChangesFile(ctx, changes, { keepMine: [`customer:edit:${R.beta}`] });
    expect(res.trialBalance.balanced).toBe(true);
    expect(res.keptYours).toEqual(['Customer Beta: kept your email']);

    // The books equal the reference file (the same work done directly), at every date.
    expect(await tbByCode(ctx)).toEqual(await tbByCode(reference.ctx));
    expect(await tbByCode(ctx, endOfDay(DIVIDING))).toEqual(await tbByCode(actx, endOfDay(DIVIDING)));

    // Split credit: 60 to invoice 1, 40 to invoice 2, both from the same client journal line.
    const credit = await arLine(ctx, R.jeCredit, acct);
    const split = await db.select().from(journalItemApplications).where(eq(journalItemApplications.journalLineId, credit));
    expect(split.map((a) => [a.invoiceId, a.amount]).sort()).toEqual([[R.inv1, '60.00'], [R.inv2, '40.00']].sort());
    expect((await db.select().from(invoices).where(eq(invoices.id, R.inv1)))[0].balanceDue).toBe('240.00');
    expect((await db.select().from(invoices).where(eq(invoices.id, R.inv2)))[0].balanceDue).toBe('160.00');
    // Two partial payments of the same charge (new payments, mapped to client ids).
    const charge = await arLine(ctx, R.jeCharge, acct);
    const paid = await db.select().from(journalItemApplications).where(eq(journalItemApplications.journalLineId, charge));
    expect(paid.map((a) => a.amount)).toEqual(['40.00', '40.00']);
    const pays = await db.select().from(paymentsReceived).where(and(eq(paymentsReceived.companyId, ctx.companyId), eq(paymentsReceived.customerId, R.beta)));
    expect(pays.map((p) => p.reference).sort()).toEqual(['P-1', 'P-2']);
    expect(new Set(paid.map((a) => a.paymentId))).toEqual(new Set(pays.map((p) => p.id)));
    // March reconciled with both look-alike payment lines (two different lines cleared).
    const [mar] = await db.select().from(reconciliations).where(eq(reconciliations.status, 'completed'));
    expect(mar.statementBalance).toBe('1080.00');
    expect(await listClearable(ctx, R.bank, endOfDay('2026-03-31'))).toEqual([]);

    // Invoice D keeps its percent discount (10% of 500); invoice E lost its estimate link.
    const [invD] = await db.select().from(invoices).where(eq(invoices.id, R.invD));
    expect(invD).toMatchObject({ discountType: 'percent', discount: '50.00', total: '450.00' });
    const eLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, R.invE));
    expect(eLines.map((l) => l.estimateLineId)).toEqual([null]);

    // Names: the client's email kept, the accountant's other fields applied.
    const [beta] = await db.select().from(customers).where(eq(customers.id, R.beta));
    expect(beta).toMatchObject({ email: 'beta@client.test', phone: '555-0003' });
    const [acme] = await db.select().from(customers).where(eq(customers.id, R.acme));
    expect(acme).toMatchObject({ email: 'acme@client.test', phone: '555-0002', customerTypeId: R.retail, customFields: { Region: 'West' } });
    const [widget] = await db.select().from(items).where(eq(items.id, R.widget));
    expect(widget).toMatchObject({ reorderPoint: '5.0000', customFields: { Bin: 'A1' } });
    expect(Number(widget.quantityOnHand)).toBe(4);
    const [gamma] = await db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'Gamma')));
    expect(gamma).toMatchObject({ priceLevelId: R.gold, customerTypeId: R.wholesale, customFields: { Region: 'East' } });
    expect(gamma.shipToAddresses).toEqual([expect.objectContaining({ name: 'Dock', line1: '1 Pier', city: 'Harbor', isDefault: true })]);
    const [gizmo] = await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Gizmo')));
    expect(gizmo).toMatchObject({ reorderPoint: '3.0000', customFields: { Bin: 'B2' } });

    // The bill's billable cost is still unbilled on the client's side.
    const [cost] = await db.select().from(billLines).where(eq(billLines.billId, R.billX));
    expect(cost.billedInvoiceId).toBeNull();
  });
});
