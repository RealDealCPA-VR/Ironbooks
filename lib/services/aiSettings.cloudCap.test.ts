/**
 * The daily cloud-call limit (lib/services/aiSettings.ts noteCloudCall): a spend guard. Calls are
 * counted per UTC day in the company's settings; at the limit the cloud provider is refused (the
 * router then tries the next provider or falls back), and 0 means no limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { AiError } from '@/lib/ai/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { cloudCallsToday, getPublicSettings, noteCloudCall, updateSettings } from './aiSettings';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-cloud-cap');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'cap@test.local', name: 'Cap', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Cap Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('daily cloud AI call limit', () => {
  it('counts calls and refuses at the limit', async () => {
    await updateSettings(ctx, { cloudDailyCap: 2 });
    expect((await getPublicSettings(ctx)).cloudDailyCap).toBe(2);
    await noteCloudCall(ctx);
    await noteCloudCall(ctx);
    expect(await cloudCallsToday(ctx)).toBe(2);
    await expect(noteCloudCall(ctx)).rejects.toMatchObject({ code: 'POLICY' });
    await expect(noteCloudCall(ctx)).rejects.toBeInstanceOf(AiError);
    expect((await getPublicSettings(ctx)).cloudCallsToday).toBe(2);
  });

  it('0 means no limit', async () => {
    await updateSettings(ctx, { cloudDailyCap: 0 });
    await noteCloudCall(ctx);
    expect(await cloudCallsToday(ctx)).toBe(3);
  });
});
