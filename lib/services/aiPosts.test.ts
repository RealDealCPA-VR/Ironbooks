/**
 * "What the AI posted" (lib/services/aiPosts.ts): every AI auto-post is listed with where it went
 * and how sure the AI was; Undo is Bank Review's Unmatch (the AI's entry is voided, the line goes
 * back to review) and the AI does not post that line again. A second Undo is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, bankTransactions, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { categorize } from './bankCategorize';
import { autoApplyBankSuggestions, retrainModel } from './aiCategorizer';
import { listAiPosts, undoAiPost } from './aiPosts';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-posts');
let db: DB;
let ctx: ServiceContext;
let bankId: string;
let fuelId: string;
let seq = 0;

async function line(date: string, amount: string) {
  seq += 1;
  const [row] = await db
    .insert(bankTransactions)
    .values({ companyId: ctx.companyId, bankAccountId: bankId, date: new Date(`${date}T12:00:00Z`), description: 'SHELL OIL 57444', amount, fitId: `p-${seq}` })
    .returning();
  return row.id;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'aiposts@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'AI Posts Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const checkingId = all.find((a) => a.subtype === 'checking')!.id;
  fuelId = all.find((a) => a.type === 'expense' && /fuel|auto|car|travel/i.test(a.name))?.id ?? all.find((a) => a.type === 'expense')!.id;
  bankId = (await db.insert(bankAccounts).values({ companyId: company.id, accountId: checkingId, bankName: 'Bank', accountNumber: '9' }).returning())[0].id;
  for (let i = 0; i < 30; i++) {
    const id = await line(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, `-${(30 + i).toFixed(2)}`);
    await categorize(ctx, { bankTransactionId: id, accountId: fuelId });
  }
  await retrainModel(ctx);
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('what the AI posted', () => {
  it('lists each auto-post and undoes it in one step', async () => {
    const id = await line('2026-03-05', '-51.20');
    const r = await autoApplyBankSuggestions(ctx, bankId);
    expect(r.applied.map((a) => a.bankTransactionId)).toContain(id);

    const posts = await listAiPosts(ctx);
    const post = posts.find((p) => p.bankTransactionId === id)!;
    expect(post).toMatchObject({ date: '2026-03-05', description: 'SHELL OIL 57444', amount: '-51.20', state: 'posted' });
    expect(Number(post.confidence)).toBeGreaterThanOrEqual(0.95);
    expect(post.accountName).toBeTruthy();

    const undone = await undoAiPost(ctx, post.id);
    expect(undone.state).toBe('undone');
    const [txn] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, id));
    expect(txn.matched).toBe(false);
    const [entry] = await db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.sourceRef, `bank_transaction:${id}`));
    expect(entry.status).not.toBe('posted');
    expect((await listAiPosts(ctx)).find((p) => p.id === post.id)!.state).toBe('undone');

    await expect(undoAiPost(ctx, post.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    // The AI leaves that line to the person from now on.
    const again = await autoApplyBankSuggestions(ctx, bankId);
    expect(again.applied.map((a) => a.bankTransactionId)).not.toContain(id);
  });

  it('a line the person matched to another entry shows as changed by you and is not undone', async () => {
    const id = await line('2026-03-09', '-44.40');
    await autoApplyBankSuggestions(ctx, bankId);
    const post = (await listAiPosts(ctx)).find((p) => p.bankTransactionId === id)!;
    expect(post.state).toBe('posted');
    // The person re-points the line at an entry of their own (what an edit of the entry also does).
    const [other] = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId)).limit(1);
    await db.update(bankTransactions).set({ matchedEntryId: other.id }).where(eq(bankTransactions.id, id));
    expect((await listAiPosts(ctx)).find((p) => p.id === post.id)!.state).toBe('changed');
    await expect(undoAiPost(ctx, post.id)).rejects.toThrow(/You changed this one/);
  });

  it('another company’s post is not found', async () => {
    await expect(undoAiPost({ ...ctx, companyId: '00000000-0000-0000-0000-000000000000' }, (await listAiPosts(ctx))[0].id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
