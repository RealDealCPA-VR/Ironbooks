/**
 * Review round 5 — "today" in the command bar, the bookkeeping assistant and the AI error review
 * is the company's calendar day (Preferences > Company time zone), not the UTC day. Before the fix,
 * at 10:30 pm in New York on Oct 31 (already Nov 1 in UTC) "today" prefilled a form dated Nov 1 and
 * "this month" / "last month" answered for the wrong month.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createExpense } from './expenses';
import { runCommand } from './commandBar';
import { ask } from './aiAssistant';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-commandbar');
/** 10:30 pm on Oct 31, 2026 in New York = 02:30 on Nov 1 in UTC. */
const EVENING_NY = new Date('2026-11-01T02:30:00.000Z');

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-cmd@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review5 Command Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  await updateCompany(ctx, { settings: { timezone: 'America/New_York' } });
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  // October spending (so "this month" has a figure in October and none in November).
  await createExpense(ctx, {
    payeeName: 'Corner Store',
    date: new Date('2026-10-20T00:00:00.000Z'),
    method: 'check',
    paymentAccountId: acct['1000'],
    lines: [{ accountId: acct['6000'], amount: '75.00' }],
  });
}, 180_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('review5: the company calendar day', () => {
  it('command bar: "today" on a form is the company day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING_NY);
    const r = await runCommand(ctx, { text: 'expense 50 Corner Store today' });
    expect(r.type).toBe('prefill');
    expect((r as { prefill: { date?: string } }).prefill.date).toBe('2026-10-31');
  });

  it('command bar: "this month" is the company month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING_NY);
    const r = await runCommand(ctx, { text: 'what did we spend this month' });
    expect(r.type).toBe('answer');
    const a = r as { range: { from: string; to: string }; amount: string };
    expect(a.range.from).toBe('2026-10-01');
    expect(a.range.to).toBe('2026-10-31');
    expect(a.amount).toBe('75.00');
  });

  it('assistant (offline mode): "this month" is the company month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING_NY);
    const reply = await ask(ctx, [], 'what were our expenses this month');
    expect(reply.mode).toBe('offline');
    expect(reply.answer).toContain('2026-10-01 to 2026-10-31');
  });
});
