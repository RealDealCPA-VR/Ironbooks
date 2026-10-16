/**
 * Accountant's Copy (PARITY I1): nothing done in the copy is silently lost, and a changes file can
 * only touch the client's records dated on or before the dividing date.
 *
 *  - Opening stock typed on a new item in the copy can't travel back (only the item does), so it
 *    is refused there with a pointer to an inventory adjustment — which does travel: the client's
 *    books after import equal the accountant's at the dividing date and an independently computed
 *    trial balance.
 *  - A hand-made / tampered file can't reach the client's later work through a payment's
 *    applications, a General Journal credit's line or the removal of a journal application.
 *  - The client reconciling a LATER statement while the copy is out (clearing lines dated on or
 *    before the dividing date — an outstanding item) blocks the accountant's earlier
 *    reconciliation: the review says so, names the cause and the way out; the import refuses with
 *    the same explanation; after Undo Last Reconciliation the file imports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, invoices, items, journalEntryLines, journalItemApplications, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createBankAccount } from '../bankAccounts';
import { createCustomer } from '../customers';
import { createItem } from '../items';
import { createItemWithOpeningStock } from '../lists/openingStock';
import { adjustQuantityAtSite } from '../inventorySiteOps';
import { createInvoice } from '../invoices';
import { receivePayment } from '../payments';
import { createManualEntry } from '../journal';
import { applyJournalCredit } from '../journalApplications';
import { completeReconciliation, listClearable, startReconciliation, toggleCleared, undoLastReconciliation } from '../reconcile';
import { trialBalance } from '../reports';
import { createAccountantCopy, importChangesFile, reviewChangesFile } from './client';
import { exportChangesFile, openAccountantCopyFile } from './accountant';
import { parseChangesFile, serializeChangesFile, type ChangesFileBody } from './format';
import { lineRefOf } from './lineRefs';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-gaps');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const endOfDay = (s: string) => new Date(`${s}T23:59:59.999Z`);
const DIVIDING = '2026-03-31';

let db: DB;
let ctx: ServiceContext;
let actx: ServiceContext;
const acct: Record<string, string> = {};
const R: Record<string, string> = {};
let changes: Buffer;

/** Net balance per account number (debit positive), zero rows left out. */
async function netByCode(c: ServiceContext, asOf?: Date): Promise<Record<string, string>> {
  const tb = await trialBalance(c, asOf);
  const out: Record<string, string> = {};
  for (const r of tb.rows) {
    const net = Money.of(r.debit).minus(Money.of(r.credit));
    if (!net.isZero()) out[r.code] = net.toFixed(2);
  }
  return out;
}

const svc = (desc: string, rate: string) => ({ description: desc, quantity: 1, rate, accountId: acct['4100'] });

function tamper(mutate: (b: ChangesFileBody) => void): Buffer {
  const { sha256: _s, ...body } = parseChangesFile(changes);
  const copy = JSON.parse(JSON.stringify(body)) as ChangesFileBody;
  mutate(copy);
  return serializeChangesFile(copy);
}

describe("Accountant's Copy — opening stock, payment applications and later reconciliations", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'gaps@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Gaps Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;

    R.acme = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
    R.bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '555555555' })).id;
    await createManualEntry(ctx, {
      date: d('2026-01-05'),
      description: 'Owner investment',
      lines: [{ accountId: acct['1000'], debit: '5000.00' }, { accountId: acct['3000'], credit: '5000.00' }],
    });
    await createManualEntry(ctx, {
      date: d('2026-01-20'),
      description: 'January deposit',
      lines: [{ accountId: acct['1000'], debit: '1200.00' }, { accountId: acct['4100'], credit: '1200.00' }],
    });
    R.invE = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-02-10'), lines: [svc('February work', '300')] })).id;

    const transfer = (await createAccountantCopy(ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId: ctx.userId };

    // The client keeps working after the dividing date while the copy is out.
    R.invLate = (await createInvoice(ctx, { customerId: R.acme, date: d('2026-04-02'), lines: [svc('April work', '200')] })).id;
    await receivePayment(ctx, {
      customerId: R.acme, date: d('2026-04-02'), method: 'check', reference: 'C-40', amount: '40', depositAccountId: acct['1050'],
      applications: [{ invoiceId: R.invLate, amountApplied: '40' }],
    });
    const lateCredit = await createManualEntry(ctx, {
      date: d('2026-04-03'),
      description: 'April courtesy credit',
      lines: [{ accountId: acct['6000'], debit: '30.00' }, { accountId: acct['1200'], credit: '30.00', entityType: 'customer', entityId: R.acme }],
    });
    const [lateLine] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, lateCredit.id), eq(journalEntryLines.accountId, acct['1200'])));
    R.lateLine = lateLine.id;
    await applyJournalCredit(ctx, { journalLineId: lateLine.id, invoiceId: R.invLate, amount: '30', date: d('2026-04-03') });
    const [app] = await db.select().from(journalItemApplications).where(eq(journalItemApplications.invoiceId, R.invLate));
    R.lateApp = app.id;
    // April statement: it clears the January deposit (dated before the dividing date).
    const april = await startReconciliation(ctx, { bankAccountId: R.bank, statementDate: d('2026-04-30'), statementBalance: '6200.00' });
    for (const l of await listClearable(ctx, R.bank, endOfDay('2026-04-30'), april.id)) await toggleCleared(ctx, april.id, l.journalEntryLineId, true);
    await completeReconciliation(ctx, april.id);
  }, 180_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('accountant: opening stock on a new item is refused (it could not travel); the item and an inventory adjustment are fine', async () => {
    const gizmo = {
      name: 'Gizmo', type: 'inventory' as const, assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'], purchaseCost: '5',
    };
    await expect(
      createItemWithOpeningStock(actx, { ...gizmo, openingQuantity: '10', openingUnitCost: '5', openingAsOf: d('2026-03-01') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/quantity on hand can't be entered on a new item[\s\S]*inventory adjustment/) });
    expect(await actx.db.select().from(items).where(eq(items.name, 'Gizmo'))).toEqual([]);

    R.gizmo = (await createItemWithOpeningStock(actx, gizmo)).item.id;
    await adjustQuantityAtSite(actx, { itemId: R.gizmo, quantityChange: '10', unitCost: '5', date: d('2026-03-01'), memo: 'Stock count', adjustmentAccountId: acct['6300'] });

    // A payment on the February invoice and the March statement, both in the copy.
    await receivePayment(actx, {
      customerId: R.acme, date: d('2026-03-15'), method: 'check', reference: 'A-100', amount: '100', depositAccountId: acct['1000'],
      applications: [{ invoiceId: R.invE, amountApplied: '100' }],
    });
    const march = await startReconciliation(actx, { bankAccountId: R.bank, statementDate: d('2026-03-31'), statementBalance: '6300.00' });
    for (const l of await listClearable(actx, R.bank, endOfDay('2026-03-31'), march.id)) await toggleCleared(actx, march.id, l.journalEntryLineId, true);
    await completeReconciliation(actx, march.id);

    changes = (await exportChangesFile(actx, {})).buffer;
    const file = parseChangesFile(changes);
    expect(file.names.map((n) => `${n.type}:${n.op}`)).toEqual(['item:add']);
    expect(file.documents.map((x) => `${x.type}:${x.op}`).sort()).toEqual(['inventory_adjustment:add', 'payment_received:add']);
  });

  it('client: a payment application retargeted to an invoice dated after the dividing date is refused, nothing changes', async () => {
    const file = tamper((b) => {
      const pay = b.documents.find((x) => x.type === 'payment_received')! as unknown as { after: { applications: Array<{ invoiceId: string }> } };
      pay.after.applications[0].invoiceId = R.invLate;
    });
    const message = expect.stringMatching(/apply a customer payment to an invoice of yours dated 2026-04-02[\s\S]*Nothing was imported/i);
    await expect(reviewChangesFile(ctx, file)).rejects.toMatchObject({ code: 'VALIDATION', message });
    const before = await netByCode(ctx);
    await expect(importChangesFile(ctx, file)).rejects.toMatchObject({ code: 'VALIDATION', message });
    expect(await netByCode(ctx)).toEqual(before);
    const [inv] = await db.select({ paid: invoices.amountPaid }).from(invoices).where(eq(invoices.id, R.invLate));
    expect(Money.of(inv.paid).toFixed(2)).toBe('70.00'); // 40 paid + 30 journal credit, untouched
  });

  it('client: a General Journal credit line, or the removal of an application, dated after the dividing date is refused', async () => {
    const lateRef = (await lineRefOf(ctx, R.lateLine))!;
    const applyLate = tamper((b) => {
      b.applications.push({ op: 'apply', kind: 'journal', id: randomUUID(), line: lateRef, invoiceId: R.invE, billId: null, chargeLine: null, amount: '10.00', date: d('2026-03-20').toISOString() });
    });
    await expect(reviewChangesFile(ctx, applyLate)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/journal entry line of yours dated 2026-04-03/) });
    await expect(importChangesFile(ctx, applyLate)).rejects.toMatchObject({ code: 'VALIDATION' });

    const unapplyLate = tamper((b) => {
      b.applications.push({ op: 'unapply', kind: 'journal', id: R.lateApp, amount: '30.00', date: d('2026-04-03').toISOString() });
    });
    await expect(reviewChangesFile(ctx, unapplyLate)).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/remove a journal entry credit application of yours dated 2026-04-03/),
    });
    await expect(importChangesFile(ctx, unapplyLate)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await db.select().from(journalItemApplications).where(eq(journalItemApplications.id, R.lateApp))).toHaveLength(1);
  });

  it('client: the review flags the March reconciliation under the client’s April one, naming the cause and the way out', async () => {
    const review = await reviewChangesFile(ctx, changes);
    expect(review.canImport).toBe(false);
    const recon = review.items.find((i) => i.group === 'reconciliation')!;
    expect(recon.problem).toMatch(/completed reconciliation of 1000 · .* later statement \(ending 2026-04-30\)/);
    expect(recon.problem).toMatch(/already cleared/);
    expect(recon.problem).toMatch(/Undo Last Reconciliation until the statement ending 2026-04-30 is undone, import these changes, then reconcile those statements again/);
    expect(review.items.filter((i) => i.problem).map((i) => i.group)).toEqual(['reconciliation']);

    const before = await netByCode(ctx);
    await expect(importChangesFile(ctx, changes)).rejects.toMatchObject({
      message: expect.stringMatching(/reconcil[\s\S]*statement ending 2026-03-31[\s\S]*later statement \(ending 2026-04-30\)[\s\S]*Undo Last Reconciliation/),
    });
    expect(await netByCode(ctx)).toEqual(before);
  });

  it('client: after undoing the April reconciliation the file imports; the books equal the accountant’s and an independent expectation', async () => {
    await undoLastReconciliation(ctx, R.bank);
    const review = await reviewChangesFile(ctx, changes);
    expect(review.items.filter((i) => i.problem)).toEqual([]);
    expect(review.canImport).toBe(true);

    const res = await importChangesFile(ctx, changes);
    expect(res.trialBalance.balanced).toBe(true);
    expect(res.applied.reconciliations).toBe(1);

    // Work on or before the dividing date matches the accountant's file exactly.
    expect(await netByCode(ctx, endOfDay(DIVIDING))).toEqual(await netByCode(actx, endOfDay(DIVIDING)));
    // Computed by hand: investment 5000, January deposit 1200, February invoice 300 (100 paid in
    // the copy), Gizmo 10 × 5 against 6300; the client's April invoice 200 (40 paid, 30 credited).
    expect(await netByCode(ctx)).toEqual({
      '1000': '6300.00',
      '1050': '40.00',
      '1200': '330.00',
      '1300': '50.00',
      '3000': '-5000.00',
      '4100': '-1700.00',
      '6000': '30.00',
      '6300': '-50.00',
    });
    const [gizmo] = await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, 'Gizmo')));
    expect(Money.of(gizmo.quantityOnHand ?? 0).toFixed(4)).toBe('10.0000');
  });
});
