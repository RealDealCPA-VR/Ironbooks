/**
 * Report summary — optional AI phrasing through the company's AI router (reportexplain).
 * The router is stubbed: a configured model's sentence is used only when it keeps every number;
 * a reply that changes a number, a failing model, or no model at all falls back to the
 * deterministic sentence. The prompt carries only the deterministic summary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ChatMessage } from '@/lib/ai/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';

const router = {
  available: true,
  reply: '' as string | Error,
  locality: 'local' as 'local' | 'cloud',
  seen: [] as ChatMessage[][],
};

vi.mock('./aiSettings', () => ({
  buildRouter: async () => ({
    isAvailable: () => router.available,
    unavailableReason: () => (router.available ? null : 'No AI model is configured. Add a local model in Settings → AI & Automation.'),
    chat: async (_task: string, messages: ChatMessage[]) => {
      router.seen.push(messages);
      if (router.reply instanceof Error) throw router.reply;
      return { content: router.reply, providerId: 'tailnet-llm', model: 'm', locality: router.locality, redacted: router.locality === 'cloud', attempts: [] };
    },
  }),
}));

const { reportSummary } = await import('./reportSummary');

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-report-summary-ai');
let db: DB;
let ctx: ServiceContext;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const P = { from: '2026-02-01', to: '2026-02-28', basis: 'accrual' };

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'sum-ai@test.local', name: 'S', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Summary AI Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const code: Record<string, string> = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) code[r.code] = r.id;
  const sale = (date: string, amt: string) =>
    postJournalEntry(ctx, { date: d(date), description: 'Sale', lines: [{ accountId: code['1000'], debit: amt }, { accountId: code['4000'], credit: amt }] });
  await sale('2026-01-15', '1000');
  await sale('2026-02-15', '1200');
  await postJournalEntry(ctx, { date: d('2026-02-20'), description: 'Ads', lines: [{ accountId: code['6000'], debit: '100' }, { accountId: code['1000'], credit: '100' }] });
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the PGlite files briefly */
  }
});

beforeEach(() => {
  router.available = true;
  router.reply = '';
  router.locality = 'local';
  router.seen = [];
});

describe('AI phrasing of the summary', () => {
  it('without ai=1 nothing is sent to the model, but availability is reported', async () => {
    const s = await reportSummary(ctx, 'profit-loss', P);
    expect(s.aiAvailable).toBe(true);
    expect(s.ai).toBeUndefined();
    expect(router.seen).toHaveLength(0);
    expect(s.text).toBe(
      'Net income is $1,100.00 for 02/01/2026 – 02/28/2026, up 10.0% (+$100.00) from the previous period ($1,000.00) and up $1,100.00 from the same period last year ($0.00). Biggest changes vs the previous period: Sales Income +$200.00, Advertising & Marketing +$100.00.',
    );
  }, 60_000);

  it('uses the model’s sentence when it keeps every number, and sends only the summary', async () => {
    router.reply = 'February net income was $1,100.00, up 10.0% on January, mostly from Sales Income (+$200.00).';
    const s = await reportSummary(ctx, 'profit-loss', P, { ai: true });
    expect(s.ai?.text).toBe(router.reply);
    expect(s.ai?.locality).toBe('local');
    expect(s.aiNotice).toBeUndefined();
    const prompt = router.seen[0].map((m) => m.content).join('\n');
    expect(prompt).toContain(s.text);
    expect(prompt).not.toMatch(/journal|entry id|[0-9a-f]{8}-[0-9a-f]{4}/i);
  }, 60_000);

  it('rejects a reply that invents or changes a number', async () => {
    router.reply = 'Net income grew 12% to $1,100.00.';
    const s = await reportSummary(ctx, 'profit-loss', P, { ai: true });
    expect(s.ai).toBeUndefined();
    expect(s.aiNotice).toMatch(/changed the numbers/);
    expect(s.text).toMatch(/^Net income is \$1,100\.00/);
  }, 60_000);

  it('falls back when the model fails or none is configured', async () => {
    router.reply = new Error('connection refused');
    const failed = await reportSummary(ctx, 'profit-loss', P, { ai: true });
    expect(failed.ai).toBeUndefined();
    expect(failed.aiNotice).toMatch(/could not answer/);
    router.available = false;
    const off = await reportSummary(ctx, 'profit-loss', P, { ai: true });
    expect(off.aiAvailable).toBe(false);
    expect(off.ai).toBeUndefined();
    expect(off.aiNotice).toMatch(/No AI model/);
    expect(off.text.length).toBeGreaterThan(20);
  }, 60_000);
});
