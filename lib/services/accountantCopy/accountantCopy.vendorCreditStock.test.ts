/**
 * Feature round (accountant team) — review round 5 leftover (inventory -> Accountant's Copy):
 * vendor credit lines carry site / bin / serial / lot detail (P1 purchases), but the changes file
 * (.ibcx) left it out, so a bill credit returning serial- or lot-tracked stock, entered in the
 * accountant's copy, was imported without it: refused (a serial-tracked return needs its serial
 * numbers) or taken out of the wrong site. The detail now travels and is checked like the other
 * forms'. Also: items are versioned by edited_at (concurrency.versionField), so the copy's baseline
 * takes an item's version from it — a sale in the client's file no longer looks like an edit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, accountantCopyBaseline, items, users, vendorCredits } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createVendor } from '../vendors';
import { createItem } from '../items';
import { createBill } from '../bills';
import { createVendorCredit } from '../vendorCredits';
import { createSite, quantityAtSite, serialsInStock } from '../inventorySites';
import { createAccountantCopy, importChangesFile, reviewChangesFile } from './client';
import { exportChangesFile, openAccountantCopyFile } from './accountant';
import { parseChangesFile } from './format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-vcstock');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

let db: DB;
let ctx: ServiceContext;
let actx: ServiceContext;
const acct: Record<string, string> = {};
const R: Record<string, string> = {};
let changes: Buffer;

describe("Accountant's Copy — a bill credit's site, serial numbers and lot travel in the changes file", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'vcstock@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'VC Stock Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    R.vendor = (await createVendor(ctx, { displayName: 'Supplier Co' })).id;
    R.east = (await createSite(ctx, { name: 'East' })).id;
    R.west = (await createSite(ctx, { name: 'West' })).id;
    const inv = { assetAccountId: acct['1300'], expenseAccountId: acct['5000'], incomeAccountId: acct['4000'] };
    R.phone = (await createItem(ctx, { name: 'Phone', type: 'inventory', trackingMode: 'serial', purchaseCost: '100', ...inv })).id;
    R.syrup = (await createItem(ctx, { name: 'Syrup', type: 'inventory', trackingMode: 'lot', purchaseCost: '2', ...inv })).id;
    R.widget = (await createItem(ctx, { name: 'Widget', type: 'inventory', purchaseCost: '10', ...inv })).id;
    await createBill(ctx, {
      vendorId: R.vendor,
      billNumber: 'B-1',
      date: d('2026-02-10'),
      lines: [
        { itemId: R.phone, quantity: 2, unitCost: '100', siteId: R.east, serialNumbers: ['SN1', 'SN2'] },
        { itemId: R.syrup, quantity: 10, unitCost: '2', siteId: R.east, lotNumber: 'L1' },
        { itemId: R.widget, quantity: 10, unitCost: '10', siteId: R.west },
      ] as never,
    });

    const transfer = (await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId: ctx.userId };

    // The accountant records the vendor's credit for returned goods.
    await createVendorCredit(actx, {
      vendorId: R.vendor,
      refNumber: 'VC-9',
      date: d('2026-03-15'),
      lines: [
        { itemId: R.phone, quantity: 1, unitCost: '100', siteId: R.east, serialNumbers: ['SN2'] },
        { itemId: R.syrup, quantity: 3, unitCost: '2', siteId: R.east, lotNumber: 'L1' },
        { itemId: R.widget, quantity: 2, unitCost: '10', siteId: R.west },
      ] as never,
    });
    changes = (await exportChangesFile(actx, {})).buffer;
  }, 300_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('the changes file carries each returned line with its site, serial numbers and lot', () => {
    const body = parseChangesFile(changes);
    const vc = body.documents.find((x) => x.type === 'vendor_credit' && x.op === 'add') as unknown as { after: { lines: Array<Record<string, unknown>> } };
    expect(vc).toBeTruthy();
    const [phone, syrup, widget] = vc.after.lines;
    // A serial number is found where it is (the line keeps no site for it).
    expect(phone).toMatchObject({ serialNumbers: ['SN2'] });
    expect(syrup).toMatchObject({ lotNumber: 'L1' });
    expect(widget).toMatchObject({ siteId: R.west });
  });

  it('the review finds nothing wrong and the import takes the stock out where it was', async () => {
    const review = await reviewChangesFile(ctx, changes);
    expect(review.items.filter((i) => i.problem)).toEqual([]);
    expect(review.canImport).toBe(true);
    await importChangesFile(ctx, changes);
    const [credit] = await db.select().from(vendorCredits).where(and(eq(vendorCredits.companyId, ctx.companyId), eq(vendorCredits.refNumber, 'VC-9')));
    expect(credit).toBeTruthy();
    const serials = await serialsInStock(ctx, { itemIds: [R.phone] });
    expect(serials.map((s) => s.serialNumber).sort()).toEqual(['SN1']);
    expect((await quantityAtSite(ctx, R.widget, R.west)).toFixed(0)).toBe('8');
    const lot = await db.execute(
      sql`SELECT COALESCE(SUM(quantity), 0)::text AS q FROM inventory_movements WHERE company_id = ${ctx.companyId}::uuid AND item_id = ${R.syrup}::uuid AND lot_number = 'L1'`,
    );
    expect(Number((lot as unknown as { rows: Array<{ q: string }> }).rows[0].q)).toBe(7);
  });

  it("an item's baseline version is its edit version (edited_at), not updated_at", async () => {
    const [row] = await actx.db
      .select({ version: accountantCopyBaseline.version })
      .from(accountantCopyBaseline)
      .where(and(eq(accountantCopyBaseline.entityType, 'item'), eq(accountantCopyBaseline.entityId, R.widget)));
    const [item] = await actx.db.select({ editedAt: items.editedAt }).from(items).where(eq(items.id, R.widget));
    expect(row.version?.getTime()).toBe(item.editedAt.getTime());
  });
});
