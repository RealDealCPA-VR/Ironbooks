/**
 * Accountant's Copy (PARITY I1): stock the client used up at one site, bin, serial number or lot.
 * The import refuses a change that would leave a single site, bin, serial or lot short (not only
 * the item's total), so the review must predict it in plain language — the client's own later
 * record and the way out — and the import must refuse with the same words, books unchanged:
 *
 *  - a February bill of 10 Widget at East voided after the client sold those 10 at East (and
 *    bought 10 at West) in April;
 *    the same for 4 Nut at West (a site other than the default);
 *  - a February bill of Phones SN1 + SN2 voided after the client sold SN1 (and bought SN3);
 *  - a February bill of lot L1 voided after the client sold lot L1 (and bought lot L2);
 *  - a February bill into bin A-01 voided after the client sold from A-01 (and bought into B-01);
 *  - a new March invoice selling Gizmo at East, where the client sold all of East's in April;
 *  - a February invoice of Phone SN5 voided after the client took SN5 back on an April credit memo;
 *  - a new March bill receiving into a site the client has made inactive.
 *
 * And no false refusal: a February bill at West voided where the client's April sale was at East.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createItem } from '../items';
import { createInvoice, voidInvoice } from '../invoices';
import { createCreditMemo } from '../creditMemos';
import { createBill, voidBill } from '../bills';
import { createBin, createSite, updateSite } from '../inventorySites';
import { trialBalance } from '../reports';
import { accountantCopyStatus, createAccountantCopy, importChangesFile, reviewChangesFile, type ChangesReview } from './client';
import { exportChangesFile, openAccountantCopyFile } from './accountant';
import { parseChangesFile, serializeChangesFile, type ChangesFileBody } from './format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-stockplaces');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const DIVIDING = '2026-03-31';

let db: DB;
let ctx: ServiceContext;
let actx: ServiceContext;
const acct: Record<string, string> = {};
const R: Record<string, string> = {};
let changes: Buffer;

type Body = ChangesFileBody;
function only(keep: (x: Body['documents'][number]) => boolean): Buffer {
  const { sha256: _s, ...body } = parseChangesFile(changes);
  const b = JSON.parse(JSON.stringify(body)) as Body;
  b.transactions = [];
  b.documents = b.documents.filter(keep);
  b.applications = [];
  b.reconciliations = [];
  return serializeChangesFile(b);
}

async function reviewOf(buf: Buffer): Promise<ChangesReview> {
  return reviewChangesFile(ctx, buf);
}
const problemOf = (r: ChangesReview, key: string) => r.items.find((i) => i.key === key)?.problem ?? null;

async function refusesWith(buf: Buffer, problem: string) {
  const before = await trialBalance(ctx);
  const err = (await importChangesFile(ctx, buf).then(
    () => null,
    (e: Error) => e,
  )) as Error | null;
  expect(err).not.toBeNull();
  expect(err!.message).toContain(problem);
  expect(err!.message).toMatch(/Nothing was imported\.$/);
  expect(err!.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  expect(await trialBalance(ctx)).toEqual(before);
  expect((await accountantCopyStatus(ctx)).current?.status).toBe('outstanding');
  const r = await reviewOf(buf);
  expect(r.canImport).toBe(false);
  expect(r.items.map((i) => i.problem)).toContain(problem);
}

async function voidCase(type: 'bill' | 'invoice', id: string) {
  const buf = only((x) => x.type === type && x.op === 'void' && x.id === id);
  const r = await reviewOf(buf);
  return { buf, p: problemOf(r, `${type}:void:${id}`) };
}

describe("Accountant's Copy — stock the client used up at a site, bin, serial number or lot", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'stockplaces@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Stock Places Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;

    R.acme = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
    R.supplier = (await createVendor(ctx, { displayName: 'Supplier Co' })).id;
    R.east = (await createSite(ctx, { name: 'East' })).id;
    R.west = (await createSite(ctx, { name: 'West' })).id;
    R.north = (await createSite(ctx, { name: 'North' })).id;
    R.binA = (await createBin(ctx, { siteId: R.east, name: 'A-01' })).id;
    R.binB = (await createBin(ctx, { siteId: R.east, name: 'B-01' })).id;
    const inv = { assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'] };
    R.widget = (await createItem(ctx, { name: 'Widget', type: 'inventory', purchaseCost: '10', ...inv })).id;
    R.phone = (await createItem(ctx, { name: 'Phone', type: 'inventory', trackingMode: 'serial', purchaseCost: '100', ...inv })).id;
    R.syrup = (await createItem(ctx, { name: 'Syrup', type: 'inventory', trackingMode: 'lot', purchaseCost: '2', ...inv })).id;
    R.bolt = (await createItem(ctx, { name: 'Bolt', type: 'inventory', purchaseCost: '1', ...inv })).id;
    R.gizmo = (await createItem(ctx, { name: 'Gizmo', type: 'inventory', purchaseCost: '5', ...inv })).id;
    R.nut = (await createItem(ctx, { name: 'Nut', type: 'inventory', purchaseCost: '1', ...inv })).id;

    const bill = async (ref: string, date: string, line: Record<string, unknown>) =>
      (await createBill(ctx, { vendorId: R.supplier, billNumber: ref, date: d(date), lines: [line as never] })).id;
    const invoice = async (c: ServiceContext, ref: string, date: string, line: Record<string, unknown>) =>
      (await createInvoice(c, { customerId: R.acme, date: d(date), refNumber: ref, lines: [line as never] })).id;

    // ---- Before the dividing date ----
    R.billW = await bill('B-W', '2026-02-10', { itemId: R.widget, quantity: 10, unitCost: '10', siteId: R.east });
    R.billP = await bill('B-P', '2026-02-10', { itemId: R.phone, quantity: 2, unitCost: '100', siteId: R.east, serialNumbers: ['SN1', 'SN2'] });
    R.billS = await bill('B-S', '2026-02-10', { itemId: R.syrup, quantity: 10, unitCost: '2', siteId: R.east, lotNumber: 'L1' });
    R.billB = await bill('B-B', '2026-02-10', { itemId: R.bolt, quantity: 10, unitCost: '1', siteId: R.east, binId: R.binA });
    R.billP5 = await bill('B-P5', '2026-02-01', { itemId: R.phone, quantity: 1, unitCost: '100', siteId: R.east, serialNumbers: ['SN5'] });
    R.invP5 = await invoice(ctx, 'F-P5', '2026-02-20', { itemId: R.phone, quantity: 1, rate: '300', siteId: R.east, serialNumbers: ['SN5'] });
    R.billG1 = await bill('B-G1', '2026-01-15', { itemId: R.gizmo, quantity: 5, unitCost: '5', siteId: R.east });
    R.billG2 = await bill('B-G2', '2026-02-15', { itemId: R.gizmo, quantity: 5, unitCost: '5', siteId: R.west });
    R.billN = await bill('B-N', '2026-02-15', { itemId: R.nut, quantity: 4, unitCost: '1', siteId: R.west });

    const transfer = (await createAccountantCopy(ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId: ctx.userId };

    // ---- The client keeps working in April ----
    await invoice(ctx, 'A-W', '2026-04-10', { itemId: R.widget, quantity: 10, rate: '25', siteId: R.east });
    await bill('B-W2', '2026-04-11', { itemId: R.widget, quantity: 10, unitCost: '10', siteId: R.west });
    await invoice(ctx, 'A-P', '2026-04-10', { itemId: R.phone, quantity: 1, rate: '300', siteId: R.east, serialNumbers: ['SN1'] });
    await bill('B-P3', '2026-04-11', { itemId: R.phone, quantity: 1, unitCost: '100', siteId: R.east, serialNumbers: ['SN3'] });
    await invoice(ctx, 'A-S', '2026-04-10', { itemId: R.syrup, quantity: 10, rate: '5', siteId: R.east, lotNumber: 'L1' });
    await bill('B-S2', '2026-04-11', { itemId: R.syrup, quantity: 10, unitCost: '2', siteId: R.east, lotNumber: 'L2' });
    await invoice(ctx, 'A-B', '2026-04-10', { itemId: R.bolt, quantity: 10, rate: '3', siteId: R.east, binId: R.binA });
    await bill('B-B2', '2026-04-11', { itemId: R.bolt, quantity: 10, unitCost: '1', siteId: R.east, binId: R.binB });
    await createCreditMemo(ctx, {
      customerId: R.acme, date: d('2026-04-12'), refNumber: 'CM-P5',
      lines: [{ itemId: R.phone, quantity: 1, rate: '300', siteId: R.east, serialNumbers: ['SN5'] } as never],
    });
    await invoice(ctx, 'A-G', '2026-04-10', { itemId: R.gizmo, quantity: 5, rate: '12', siteId: R.east });
    await invoice(ctx, 'A-N', '2026-04-10', { itemId: R.nut, quantity: 4, rate: '2', siteId: R.west });
    await bill('B-N2', '2026-04-11', { itemId: R.nut, quantity: 4, unitCost: '1', siteId: R.east });
    await updateSite(ctx, R.north, { isActive: false });

    // ---- The accountant's changes, all dated on or before the dividing date ----
    await invoice(actx, 'M-G', '2026-03-20', { itemId: R.gizmo, quantity: 3, rate: '12', siteId: R.east });
    for (const id of [R.billW, R.billP, R.billS, R.billB, R.billG2, R.billN]) await voidBill(actx, id);
    await voidInvoice(actx, R.invP5);
    await createBill(actx, { vendorId: R.supplier, billNumber: 'M-N', date: d('2026-03-25'), lines: [{ itemId: R.widget, quantity: 1, unitCost: '10', siteId: R.north } as never] });

    changes = (await exportChangesFile(actx, {})).buffer;
  }, 300_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('a bill of 10 Widget at East voided after the client sold those 10 at East (and bought 10 at West): flagged, the import refuses alike', async () => {
    const { buf, p } = await voidCase('bill', R.billW);
    expect(p).toMatch(/Since the dividing date your file has sold or used "Widget" at site "East": your invoice #A-W \(Acme Corp\) dated 2026-04-10 \(10 sold\)/);
    expect(p).toMatch(/So only 0 of "Widget" are on hand at site "East", and your accountant's void of bill #B-W \(Supplier Co\) would take 10 out of stock there/);
    expect(p).toMatch(/or transfer stock to "East" first/);
    await refusesWith(buf, p!);
  });

  it('the same at a site other than the default (4 Nut at West): flagged, the import refuses alike', async () => {
    const { buf, p } = await voidCase('bill', R.billN);
    expect(p).toMatch(/Since the dividing date your file has sold or used "Nut" at site "West": your invoice #A-N \(Acme Corp\) dated 2026-04-10 \(4 sold\)/);
    expect(p).toMatch(/So only 0 of "Nut" are on hand at site "West", and your accountant's void of bill #B-N \(Supplier Co\) would take 4 out of stock there/);
    await refusesWith(buf, p!);
  });

  it('a bill of Phones SN1 and SN2 voided after the client sold SN1 (and bought SN3): flagged, the import refuses alike', async () => {
    const { buf, p } = await voidCase('bill', R.billP);
    expect(p).toMatch(/Since the dividing date your file has sold or used serial number "SN1" of "Phone": your invoice #A-P \(Acme Corp\) dated 2026-04-10 \(1 sold\)/);
    expect(p).toMatch(/So "SN1" is no longer in stock at site "East", and your accountant's void of bill #B-P \(Supplier Co\) would take it out of stock/);
    await refusesWith(buf, p!);
  });

  it('a bill of lot L1 voided after the client sold lot L1 (and bought lot L2): flagged, the import refuses alike', async () => {
    const { buf, p } = await voidCase('bill', R.billS);
    expect(p).toMatch(/Since the dividing date your file has sold or used lot "L1" of "Syrup" at site "East": your invoice #A-S \(Acme Corp\) dated 2026-04-10 \(10 sold\)/);
    expect(p).toMatch(/So only 0 of lot "L1" are on hand there, and your accountant's void of bill #B-S \(Supplier Co\) would take 10 of it out of stock/);
    await refusesWith(buf, p!);
  });

  it('a bill into bin A-01 voided after the client sold from A-01 (and bought into B-01): flagged, the import refuses alike', async () => {
    const { buf, p } = await voidCase('bill', R.billB);
    expect(p).toMatch(/Since the dividing date your file has sold or used "Bolt" in bin "A-01" at site "East": your invoice #A-B \(Acme Corp\) dated 2026-04-10 \(10 sold\)/);
    expect(p).toMatch(/your accountant's void of bill #B-B \(Supplier Co\) would take 10 out of stock there/);
    await refusesWith(buf, p!);
  });

  it('a new March invoice selling Gizmo at East, all of East sold by the client in April: flagged, the import refuses alike', async () => {
    const buf = only((x) => x.type === 'invoice' && x.op === 'add');
    const item = (await reviewOf(buf)).items.find((i) => i.key.startsWith('invoice:add:'))!;
    expect(item.problem).toMatch(/your file has sold or used "Gizmo" at site "East": your invoice #A-G \(Acme Corp\) dated 2026-04-10 \(5 sold\)/);
    expect(item.problem).toMatch(/your accountant's new invoice would take 3 out of stock there/);
    expect(item.problem).toMatch(/ask your accountant to change this new invoice\.$/);
    await refusesWith(buf, item.problem!);
  });

  it('an invoice of Phone SN5 voided after the client took SN5 back on an April credit memo: flagged, the import refuses alike', async () => {
    const { buf, p } = await voidCase('invoice', R.invP5);
    expect(p).toMatch(/Since the dividing date your file has received serial number "SN5" of "Phone": your credit memo #CM-P5 \(Acme Corp\) dated 2026-04-12 \(1 returned\)/);
    expect(p).toMatch(/So "SN5" is already in stock, and your accountant's void of invoice #F-P5 \(Acme Corp\) would put it in stock a second time/);
    await refusesWith(buf, p!);
  });

  it('a new March bill receiving into a site the client has made inactive: flagged, the import refuses alike', async () => {
    const buf = only((x) => x.type === 'bill' && x.op === 'add');
    const item = (await reviewOf(buf)).items.find((i) => i.key.startsWith('bill:add:'))!;
    expect(item.problem).toMatch(/Your file has made inventory site "North" inactive since this copy was made, so your accountant's new bill can't move "Widget" there/);
    expect(item.problem).toMatch(/To import: make "North" active again, import these changes, then make it inactive again/);
    await refusesWith(buf, item.problem!);
  });

  it('a bill at West voided where the client sold at East (nothing used at West): not flagged, and it imports', async () => {
    const { buf, p } = await voidCase('bill', R.billG2);
    expect(p).toBeNull();
    const r = await reviewOf(buf);
    expect(r.items.filter((i) => i.problem)).toEqual([]);
    expect(r.canImport).toBe(true);
    const res = await importChangesFile(ctx, buf);
    expect(res.trialBalance.balanced).toBe(true);
    expect(res.copy.status).toBe('imported');
  });
});
