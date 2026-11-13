/**
 * Auto-posting must never double-book (lib/services/aiCategorizer.ts autoApplyBankSuggestions):
 *  - a confident line with no match candidate is posted;
 *  - a line that may match an entry already in the books (an entered check) is left for review;
 *  - a line the AI posted before and the person undid (Unmatch) is never posted again;
 *  - a line dated on or before the imported QuickBooks history (the cutover) is left alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, bankTransactions, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { categorize, unmatch } from './bankCategorize';
import { autoApplyBankSuggestions, retrainModel } from './aiCategorizer';
import { postJournalEntry } from './posting';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-auto-post-safety');
let db: DB;
let ctx: ServiceContext;
let bankId: string;
let checkingId: string;
let fuelId: string;
let seq = 0;

async function line(date: string, amount = '-42.10', description = 'SHELL OIL 57444') {
  seq += 1;
  const [row] = await db
    .insert(bankTransactions)
    .values({ companyId: ctx.companyId, bankAccountId: bankId, date: new Date(`${date}T12:00:00Z`), description, amount, fitId: `s-${seq}` })
    .returning();
  return row.id;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'safety@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Safety Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  checkingId = all.find((a) => a.subtype === 'checking')!.id;
  fuelId = all.find((a) => a.type === 'expense' && /fuel|auto|car|travel/i.test(a.name))?.id ?? all.find((a) => a.type === 'expense')!.id;
  bankId = (await db.insert(bankAccounts).values({ companyId: company.id, accountId: checkingId, bankName: 'Bank', accountNumber: '9' }).returning())[0].id;
  // History: the person categorized SHELL OIL as fuel 30 times.
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

describe('auto-posting never double-books', () => {
  it('posts a clean confident line, but not one that matches an entry already in the books', async () => {
    const clean = await line('2026-03-05', '-51.20');
    // A check already entered for the same amount and day: the bank line should MATCH it.
    await postJournalEntry(ctx, {
      date: new Date('2026-03-06T12:00:00Z'),
      description: 'Check 1201 Shell Oil',
      lines: [
        { accountId: fuelId, debit: '63.40', credit: null },
        { accountId: checkingId, debit: null, credit: '63.40' },
      ],
    });
    const matching = await line('2026-03-06', '-63.40');
    const r = await autoApplyBankSuggestions(ctx, bankId);
    expect(r.applied.map((a) => a.bankTransactionId)).toContain(clean);
    expect(r.applied.map((a) => a.bankTransactionId)).not.toContain(matching);
    expect(r.skipped.find((s) => s.bankTransactionId === matching)?.reason).toMatch(/match/i);
  });

  it('a line the AI posted and the person undid is not posted again', async () => {
    const id = await line('2026-03-10', '-47.75');
    expect((await autoApplyBankSuggestions(ctx, bankId)).applied.map((a) => a.bankTransactionId)).toContain(id);
    await unmatch(ctx, id);
    const again = await autoApplyBankSuggestions(ctx, bankId);
    expect(again.applied.map((a) => a.bankTransactionId)).not.toContain(id);
    expect(again.skipped.find((s) => s.bankTransactionId === id)?.reason).toMatch(/undone/);
  });

  it('a line dated on or before the imported QuickBooks history is left alone', async () => {
    await postJournalEntry(ctx, {
      date: new Date('2026-04-30T12:00:00Z'),
      description: 'QuickBooks history',
      sourceRef: 'qbgl:cutover-1',
      lines: [
        { accountId: fuelId, debit: '10.00', credit: null },
        { accountId: checkingId, debit: null, credit: '10.00' },
      ],
    });
    const before = await line('2026-04-20', '-39.95');
    const after = await line('2026-05-03', '-44.05');
    const r = await autoApplyBankSuggestions(ctx, bankId);
    expect(r.applied.map((a) => a.bankTransactionId)).toContain(after);
    expect(r.applied.map((a) => a.bankTransactionId)).not.toContain(before);
    expect(r.skipped.find((s) => s.bankTransactionId === before)?.reason).toMatch(/QuickBooks history/);
  });
});
