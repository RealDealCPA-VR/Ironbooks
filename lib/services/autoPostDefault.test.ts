/**
 * Auto-posting default (lib/services/company.ts createCompany): a NEW company starts with the AI
 * posting bank lines it is at least 95% sure of; a company that has no AI settings row (made
 * before this) stays off. AI & Automation can turn it off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { aiSettings, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { getPublicSettings, updateSettings } from './aiSettings';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-auto-post-default');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'autopost@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Auto Post Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('auto-posting default', () => {
  it('a new company starts with auto-posting on at 95%', async () => {
    const s = await getPublicSettings(ctx);
    expect(s.autoApplyEnabled).toBe(true);
    expect(Number(s.autoApplyThreshold)).toBe(0.95);
  });

  it('a company without an AI settings row (made before this) stays off', async () => {
    await db.delete(aiSettings).where(eq(aiSettings.companyId, ctx.companyId));
    expect((await getPublicSettings(ctx)).autoApplyEnabled).toBe(false);
  });

  it('it can be turned off', async () => {
    await updateSettings(ctx, { autoApplyEnabled: false });
    expect((await getPublicSettings(ctx)).autoApplyEnabled).toBe(false);
  });
});
