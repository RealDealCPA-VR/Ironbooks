/**
 * First-use defaults are made by a person's first visit only (agent full access, decision "reads
 * that write"): the default inventory site (lib/services/inventorySites.ts ensureDefaultSite) and
 * the default payroll items (lib/services/payrollItems.ts ensureDefaultPayrollItems, GET
 * /api/payroll-items). An agent's read, or any read-only context, answers as if nothing had been
 * set up yet and writes nothing; a person's first visit makes them exactly as before.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const holder = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context')>()),
  getServerContext: vi.fn(async () => holder.ctx),
}));

import { closeDb, getDb, type DB } from '@/lib/db';
import { readOnlyDb } from '@/lib/db/readOnly';
import { auditLogs, inventorySites, items, payrollItems, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { defaultSiteForRead, listSites, siteQuantities } from './inventorySites';
import {
  NO_SITE_YET_NOTE,
  itemSiteDetail,
  quantityOnHandBySite,
  reorderBySite,
  serialLotInStock,
  stockStatusBySite,
  transactionsBySerialLot,
  verifySiteInvariants,
} from './inventorySiteReports';
import { ensureDefaultPayrollItems } from './payrollItems';
import { GET as payrollItemsGET } from '@/app/api/payroll-items/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-first-use-defaults');
const AGENT = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Reading agent', mode: 'read_only' as const };

let db: DB;
let companyId: string;
let person: ServiceContext;
let itemId: string;

/** An agent's read as lib/agentContext.ts builds it: the read-only handle, readOnly, view-only. */
const agentRead = (): ServiceContext => ({ db: readOnlyDb(db), companyId, userId: null, role: 'viewer', readOnly: true, agent: AGENT });
/** An agent's context with a handle that can write (the door's run): a read in it still makes nothing. */
const agentWritable = (): ServiceContext => ({ db, companyId, userId: null, role: 'accountant', agent: AGENT });

async function counts() {
  const sites = await db.select({ id: inventorySites.id }).from(inventorySites).where(eq(inventorySites.companyId, companyId));
  const pay = await db.select({ id: payrollItems.id }).from(payrollItems).where(eq(payrollItems.companyId, companyId));
  const audit = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.companyId, companyId));
  return { sites: sites.length, payrollItems: pay.length, audit: audit.length };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@first-use.test', name: 'Olive Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'First Use Co', ownerId: u.id });
  companyId = company.id;
  person = { db, companyId, userId: u.id };
  const [it] = await db
    .insert(items)
    .values({ companyId, name: 'Widget', type: 'inventory', quantityOnHand: '10', averageCost: '0', reorderPoint: '20' } as never)
    .returning();
  itemId = it.id;
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('the default inventory site', () => {
  it("an agent's read before anyone opened the sites answers as if no site exists, and writes nothing", async () => {
    const before = await counts();
    expect(before.sites).toBe(0);
    for (const ctx of [agentRead(), agentWritable()]) {
      expect(await defaultSiteForRead(ctx)).toBeNull();
      expect(await listSites(ctx)).toEqual([]);
      expect(await listSites(ctx, { includeInactive: true })).toEqual([]);
      // No site holds the stock yet.
      expect((await siteQuantities(ctx)).get(itemId)).toEqual(new Map());
      // The stock is real, just at no site yet: each item's total still counts it, and the note says
      // why there are no sites, so the report does not read as "no stock" or "nothing to reorder".
      expect(await quantityOnHandBySite(ctx)).toEqual({
        sites: [],
        rows: [expect.objectContaining({ itemId, bySite: {}, totalQuantity: '10.0000', notAtASite: '10.0000' })],
        grandTotalValue: '0.00',
        note: NO_SITE_YET_NOTE,
      });
      expect(await stockStatusBySite(ctx)).toEqual({ rows: [], attentionCount: 0, note: NO_SITE_YET_NOTE });
      expect(await reorderBySite(ctx)).toEqual({ rows: [], note: NO_SITE_YET_NOTE });
      expect(await serialLotInStock(ctx)).toEqual({ serials: [], lots: [] });
      expect(await transactionsBySerialLot(ctx, {})).toEqual({ rows: [] });
      const detail = await itemSiteDetail(ctx, itemId);
      expect(detail.sites).toEqual([]);
      expect(detail.rows).toMatchObject([{ itemId, bySite: {}, totalQuantity: '10.0000', notAtASite: '10.0000' }]);
      expect(detail.note).toBe(NO_SITE_YET_NOTE);
      // The self-check judges the stock as it will be once the default site is made: all is well.
      const checks = await verifySiteInvariants(ctx);
      expect(checks.checks.find((c) => c.name === 'Site quantities add up to quantity on hand')).toMatchObject({ ok: true });
      expect(checks.checks.find((c) => c.name === 'No negative site quantities')).toMatchObject({ ok: true });
    }
    expect(await counts()).toEqual(before);
  });

  it("a person's first visit makes Main Warehouse as before; an agent's read then sees it and its stock", async () => {
    const sites = await listSites(person);
    expect(sites).toMatchObject([{ name: 'Main Warehouse', isDefault: true }]);
    expect((await counts()).sites).toBe(1);
    const main = sites[0].id;
    for (const ctx of [agentRead(), agentWritable()]) {
      expect((await defaultSiteForRead(ctx))?.id).toBe(main);
      expect((await listSites(ctx)).map((s) => s.id)).toEqual([main]);
      expect((await siteQuantities(ctx)).get(itemId)?.get(main)?.toFixed(4)).toBe('10.0000');
      const qoh = await quantityOnHandBySite(ctx);
      expect(qoh.rows).toMatchObject([{ itemId, totalQuantity: '10.0000', bySite: { [main]: '10.0000' } }]);
      expect(qoh.rows[0]).not.toHaveProperty('notAtASite');
      expect(qoh).not.toHaveProperty('note');
      const reorder = await reorderBySite(ctx);
      expect(reorder.rows).toMatchObject([{ siteId: main, itemId, needsReorder: true }]);
      expect(reorder).not.toHaveProperty('note');
      expect((await verifySiteInvariants(ctx)).allOk).toBe(true);
    }
    expect((await counts()).sites).toBe(1);
  });
});

describe('the default payroll items', () => {
  const get = () => payrollItemsGET(new NextRequest('http://localhost/api/payroll-items'));

  it("an agent's read before anyone opened the list gets an empty list and seeds nothing", async () => {
    const before = await counts();
    expect(before.payrollItems).toBe(0);
    expect(await ensureDefaultPayrollItems(agentRead())).toEqual([]);
    // A read-only context of any kind, not only an agent's.
    expect(await ensureDefaultPayrollItems({ db: readOnlyDb(db), companyId, userId: null })).toEqual([]);
    expect(await ensureDefaultPayrollItems({ ...person, readOnly: true })).toEqual([]);
    for (const ctx of [agentRead(), agentWritable()]) {
      holder.ctx = ctx;
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
    expect(await counts()).toEqual(before);
  });

  it("a person's first visit seeds the standard set as before, and an agent then reads it", async () => {
    holder.ctx = person;
    const res = await get();
    expect(res.status).toBe(200);
    const seeded = (await res.json()) as Array<{ name: string }>;
    expect(seeded.length).toBeGreaterThan(10);
    expect(seeded.map((r) => r.name)).toContain('Federal Withholding');
    holder.ctx = agentRead();
    expect(((await (await get()).json()) as unknown[]).length).toBe(seeded.length);
    expect((await counts()).payrollItems).toBe(seeded.length);
  });
});
