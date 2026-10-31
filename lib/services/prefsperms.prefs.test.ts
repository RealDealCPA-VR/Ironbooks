/**
 * prefsperms (PARITY A1 / A2): preferences that must take effect.
 *
 *  - Reports & Graphs > "Reports show accounts by" (accountDisplay): every report names accounts
 *    by name, description, or both (QB "Show accounts by"). It only reached the journal page's
 *    account picker before; reports always used the name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-prefs');
process.env.BKA_DATA_DIR = TEST_DIR;

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createManualEntry } from './journal';
import { runStandardReport } from './reportRegistry';
import { loadAccountMeta } from './reportEngine';

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'prefs@acme.test', name: 'Pat Prefs', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Prefs Co', ownerId: u.id });
  ctx = { db, companyId: company.id, userId: u.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  await db.update(accounts).set({ description: 'Consulting revenue' }).where(eq(accounts.id, acct['4000']));
  await createManualEntry(ctx, {
    date: new Date('2026-03-10T00:00:00Z'),
    description: 'Fee',
    lines: [
      { accountId: acct['1000'], debit: '500.00' },
      { accountId: acct['4000'], credit: '500.00' },
    ],
  } as never);
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* Windows */
  }
});

async function plLabels(): Promise<string[]> {
  const r = await runStandardReport(ctx, 'profit-loss', { from: '2026-01-01', to: '2026-12-31' });
  return r.rows.map((x) => String(x.cells.label ?? ''));
}

describe('A1: Reports show accounts by (accountDisplay)', () => {
  it('name (the default): the account name', async () => {
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct['4000']));
    const labels = await plLabels();
    expect(labels).toContain(a.name);
    expect(labels.some((l) => l.includes('Consulting revenue'))).toBe(false);
  });

  it('description only: the description (the name when an account has none)', async () => {
    await updateCompany(ctx, { settings: { accountDisplay: 'description' } } as never);
    const labels = await plLabels();
    expect(labels).toContain('Consulting revenue');
    expect(labels).toContain('Total Income');
    // Detail reports name accounts the same way.
    const detail = await runStandardReport(ctx, 'transaction-detail-by-account', { from: '2026-01-01', to: '2026-12-31' });
    expect(JSON.stringify(detail.rows)).toContain('Consulting revenue');
  });

  it('name and description', async () => {
    await updateCompany(ctx, { settings: { accountDisplay: 'both' } } as never);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct['4000']));
    expect(await plLabels()).toContain(`${a.name} (Consulting revenue)`);
  });

  it('raw metadata (cross-company matching) keeps the real names', async () => {
    const meta = await loadAccountMeta(ctx, { raw: true });
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct['4000']));
    expect(meta.get(acct['4000'])!.name).toBe(a.name);
    await updateCompany(ctx, { settings: { accountDisplay: 'name' } } as never);
  });
});
