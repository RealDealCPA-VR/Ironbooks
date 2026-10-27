/**
 * Review round 5 — company management (app/api/companies/[id]/manage.ts).
 *
 * Opening a company (POST /api/companies/select) stamps settings.lastOpenedAt. It read the whole
 * settings object, then wrote it back: a settings change another request made in between (in
 * multi-user mode: an Admin setting the file password, the closing date, doc numbers…) was
 * silently undone. Same for archiving. Both now change only their own keys, in one statement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { companies, userCompanies, users } from '@/lib/db/schema';
import { archiveCompany, stampLastOpened } from '@/app/api/companies/[id]/manage';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-company-manage-r5');
let db: DB;
let ownerId: string;
let companyA: string;
let companyB: string;

/** Another request's settings change (the same atomic style lib/services/docNumbers.ts uses). */
function otherRequestSets(companyId: string, key: string, value: string) {
  return db
    .update(companies)
    .set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object(${key}::text, ${value}::text)` })
    .where(eq(companies.id, companyId));
}

async function settingsOf(companyId: string) {
  const [c] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  return (c?.settings ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner5@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  ownerId = u.id;
  for (const name of ['Gamma Co', 'Delta Co']) {
    const [c] = await db.insert(companies).values({ name, ownerId, settings: { keepMe: 1 } }).returning();
    await db.insert(userCompanies).values({ userId: ownerId, companyId: c.id, role: 'owner' });
    if (name === 'Gamma Co') companyA = c.id;
    else companyB = c.id;
  }
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('settings written by two requests at once', () => {
  it('opening a company never undoes a settings change made at the same moment', async () => {
    await Promise.all([stampLastOpened(db, companyA), otherRequestSets(companyA, 'closingDate', '2026-09-30')]);
    const s = await settingsOf(companyA);
    expect(s.closingDate).toBe('2026-09-30');
    expect(typeof s.lastOpenedAt).toBe('string');
    expect(s.keepMe).toBe(1);
  });

  it('archiving never undoes a settings change made at the same moment', async () => {
    await Promise.all([archiveCompany(db, ownerId, companyB, 'Delta Co'), otherRequestSets(companyB, 'closingDate', '2026-06-30')]);
    const s = await settingsOf(companyB);
    expect(s.closingDate).toBe('2026-06-30');
    expect(s.archived).toBe(true);
    expect(s.keepMe).toBe(1);
  });
});
