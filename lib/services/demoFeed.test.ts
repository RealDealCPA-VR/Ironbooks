import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, auditLogs, bankAccounts, bankTransactions } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { loadDemoFeed } from './demoFeed';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-demo-feed');
let db: DB;
let ctx: ServiceContext;
let bankAccountId: string;

describe('demo bank feed', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'd@t.local', name: 'D', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'Demo Feed Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    const [gl] = await db
      .insert(accounts)
      .values({ companyId: c.id, code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' })
      .returning();
    const [ba] = await db
      .insert(bankAccounts)
      .values({ companyId: c.id, accountId: gl.id, bankName: 'Demo Bank', accountNumber: '1' })
      .returning();
    bankAccountId = ba.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('loads sample transactions and dedupes on repeat', async () => {
    const first = await loadDemoFeed(ctx, bankAccountId, new Date('2026-04-01'));
    expect(first.imported).toBeGreaterThan(0);
    const rows = await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, bankAccountId));
    expect(rows.length).toBe(first.imported);

    const second = await loadDemoFeed(ctx, bankAccountId, new Date('2026-04-01'));
    expect(second.imported).toBe(0); // all deduped
  });

  it('writes one audit row per line it adds (an agent preview of the load shows them), none on a repeat', async () => {
    const audit = () =>
      db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'bank_transaction')));
    const rows = await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, bankAccountId));
    const logged = await audit();
    expect(logged.map((a) => a.entityId).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(logged.every((a) => a.action === 'create')).toBe(true);
    const stripe = rows.find((r) => r.payee === 'Stripe')!;
    expect(logged.find((a) => a.entityId === stripe.id)?.newValues).toMatchObject({
      source: 'demo_feed',
      bankAccountId,
      fitId: `${bankAccountId}:demo-001`,
      description: 'STRIPE TRANSFER',
      payee: 'Stripe',
      amount: '2450.00',
    });
    await loadDemoFeed(ctx, bankAccountId, new Date('2026-04-01'));
    expect(await audit()).toHaveLength(logged.length);
  });
});
