/**
 * Test-only helper for the wave-2 Preferences package tests: a hermetic company file in a fresh
 * temp directory (own PGlite data dir + attachments dir), seeded with the default chart of
 * accounts, plus an owner context. Not imported by application code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';

export interface TestCompany {
  dir: string;
  db: DB;
  ctx: ServiceContext;
  /** Account id by chart-of-accounts code (default COA). */
  acct: Record<string, string>;
  cleanup: () => Promise<void>;
}

export async function makeTestCompany(label: string): Promise<TestCompany> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bka-${label}-`));
  process.env.BKA_DATA_DIR = dir;
  const db = await getDb(dir);
  const [user] = await db
    .insert(users)
    .values({ email: `${label}-${Date.now()}@test.local`, name: `${label} owner`, passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: `${label} Co`, ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  return {
    dir,
    db,
    ctx,
    acct,
    cleanup: async () => {
      await closeDb(dir);
      delete process.env.BKA_DATA_DIR;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort on Windows */
      }
    },
  };
}

/** Add another user to the company with a legacy role (for per-user / viewer tests). */
export async function addMember(
  t: TestCompany,
  role: 'owner' | 'admin' | 'accountant' | 'viewer',
  label: string = role,
): Promise<ServiceContext> {
  const { userCompanies } = await import('@/lib/db/schema');
  const [u] = await t.db
    .insert(users)
    .values({ email: `${label}-${Date.now()}-${Math.random()}@test.local`, name: label, passwordHash: 'x' })
    .returning();
  await t.db.insert(userCompanies).values({ userId: u.id, companyId: t.ctx.companyId, role });
  return { db: t.db, companyId: t.ctx.companyId, userId: u.id, role };
}
