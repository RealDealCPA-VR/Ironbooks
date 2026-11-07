/**
 * "Allow cloud AI" is one switch (lib/services/networkPolicy.ts allowCloudPurpose): saving the AI
 * page with cloud on also lets AI through Privacy & Network — mode up to allow-cloud, AI opted in,
 * other opt-ins untouched. Offline mode is a deliberate choice and is reported, never overridden.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { decideOutbound } from '@/lib/net/policy';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { allowCloudPurpose, getNetworkPolicy, setNetworkPolicy } from './networkPolicy';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-allow-cloud-ai');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.BKA_NETWORK_MODE;
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'owner@allowcloud.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Allow Cloud Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('allowCloudPurpose', () => {
  it('from the default policy, cloud AI becomes allowed in one step and nothing else is opted in', async () => {
    const before = await getNetworkPolicy(ctx);
    expect(decideOutbound(before, 'https://api.openai.com/v1', 'ai', undefined).allowed).toBe(false);
    const r = await allowCloudPurpose(ctx, 'ai');
    expect(r).toEqual({ changed: true, notice: null });
    const after = await getNetworkPolicy(ctx);
    expect(after.mode).toBe('allow-cloud');
    expect(after.cloudOptIn.ai).toBe(true);
    expect(after.cloudOptIn.email).toBe(false);
    expect(decideOutbound(after, 'https://api.openai.com/v1', 'ai', undefined).allowed).toBe(true);
    // Already allowed: nothing to change.
    expect(await allowCloudPurpose(ctx, 'ai')).toEqual({ changed: false, notice: null });
  });

  it('offline mode is respected and explained', async () => {
    await setNetworkPolicy(ctx, { mode: 'offline', cloudOptIn: { ai: true } });
    const r = await allowCloudPurpose(ctx, 'ai');
    expect(r.changed).toBe(false);
    expect(r.notice).toMatch(/Offline mode/);
    expect((await getNetworkPolicy(ctx)).mode).toBe('offline');
  });
});
