/**
 * Review round 4 — an assembly build / unbuild is a dated transaction: one dated on or before the
 * dividing date of an outstanding Accountant's Copy is refused in the client's file even when its
 * components cost $0 (no ledger entry is posted, so posting.ts never checks the period — the
 * service has to, like inventory transfers). Fails until assemblies.ts checks the period itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, items, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createManualEntry } from './journal';
import { buildAssembly, setBom } from './assemblies';
import { createAccountantCopy } from './accountantCopy/client';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-acctcopy-build');
const CLIENT_DIR = path.join(ROOT, 'client');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

let db: DB;
let ctx: ServiceContext;

describe("review4: assembly builds and the Accountant's Copy dividing date", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'r4build@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Review4 Build Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    const acct: Record<string, string> = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    await createManualEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Owner investment',
      lines: [{ accountId: acct['1000'], debit: '1000.00' }, { accountId: acct['3000'], credit: '1000.00' }],
    });
    await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR });
  }, 240_000);

  afterAll(async () => {
    await closeDb(CLIENT_DIR).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('a build dated on or before the dividing date is refused even when its components cost $0', async () => {
    const mk = async (name: string, qty: string, cost: string) =>
      (await db.insert(items).values({ companyId: ctx.companyId, name, type: 'inventory', quantityOnHand: qty, averageCost: cost }).returning())[0].id;
    const kit = await mk('Kit', '0', '0');
    const free = await mk('Free sample', '10.0000', '0');
    const paid = await mk('Bought part', '10.0000', '5.0000');
    const kit2 = await mk('Kit 2', '0', '0');
    await setBom(ctx, kit, [{ componentItemId: free, quantity: '1' }]);
    await setBom(ctx, kit2, [{ componentItemId: paid, quantity: '1' }]);
    const res = async (id: string) => buildAssembly(ctx, { assemblyItemId: id, quantity: '1', date: d('2026-03-15') }).then(() => 'built', (e: Error) => e.message);
    // The $5 build is refused by the dividing date (its ledger entry is checked); the $0 one must be too.
    expect({ paid: await res(kit2), free: await res(kit) }).toEqual({
      paid: expect.stringMatching(/Accountant.s Copy/),
      free: expect.stringMatching(/Accountant.s Copy/),
    });
  });
});
