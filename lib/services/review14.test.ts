/**
 * Office feedback after 1.7.10 — registers, accounts, deposits. Each test failed before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, deposits, expenses, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount, deleteUnusedAccount } from './accounts';
import { createManualEntry } from './journal';
import { enterRegisterTransaction } from './registerEntry';
import { voidOrDeleteEntryTransaction } from './accountant/batchVoid';
import { AccessKeyText } from '@/components/AccessKey';
import { simpleNavGroups } from '@/lib/nav';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review14');
let db: DB;
let ctx: ServiceContext;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function glBalance(accountId: string): Promise<string> {
  const [r] = await db
    .select({ b: sql<string>`COALESCE(SUM(COALESCE(${journalEntryLines.debit}, 0)::numeric - COALESCE(${journalEntryLines.credit}, 0)::numeric), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)));
  return Money.of(r?.b ?? '0').toFixed(2);
}

describe('review 14: register and account fixes from the office', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review14@test.local', name: 'R14', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `R14 Co ${seq}`, ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('an unused account can be deleted; a used or system account is refused with the reason', async () => {
    const unused = await createAccount(ctx, { code: '6950', name: 'Never Used', type: 'expense' as never, subtype: 'operating_expenses' } as never);
    await expect(deleteUnusedAccount(ctx, unused.id)).resolves.toMatchObject({ deleted: true });
    expect(await db.select().from(accounts).where(eq(accounts.id, unused.id))).toHaveLength(0);

    const used = await createAccount(ctx, { code: '6960', name: 'Used Once', type: 'expense' as never, subtype: 'operating_expenses' } as never);
    await createManualEntry(ctx, {
      date: d('2026-01-05'),
      description: 'Supplies',
      lines: [
        { accountId: used.id, debit: '10.00' },
        { accountId: acct['1000'], credit: '10.00' },
      ],
    });
    await expect(deleteUnusedAccount(ctx, used.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(deleteUnusedAccount(ctx, acct['1200'])).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a register line can be voided (a deposit) or deleted (a journal entry); a check is voided, not deleted', async () => {
    const dep = await enterRegisterTransaction(ctx, acct['1000'], { date: d('2026-01-02'), payee: 'Owner', otherAccountId: acct['3000'], side: 'increase', amount: '500' });
    const [depRow] = await db.select().from(deposits).where(eq(deposits.id, dep.id));
    await voidOrDeleteEntryTransaction(ctx, depRow.postedEntryId!, 'void');
    expect(await glBalance(acct['1000'])).toBe('0.00');

    const chk = await enterRegisterTransaction(ctx, acct['1000'], { date: d('2026-01-03'), number: '101', payee: 'Office Depot', otherAccountId: acct['6300'], side: 'decrease', amount: '40' });
    const [chkRow] = await db.select().from(expenses).where(eq(expenses.id, chk.id));
    await expect(voidOrDeleteEntryTransaction(ctx, chkRow.postedEntryId!, 'delete')).rejects.toMatchObject({ code: 'CONFLICT' });
    await voidOrDeleteEntryTransaction(ctx, chkRow.postedEntryId!, 'void');
    expect(await glBalance(acct['6300'])).toBe('0.00');

    const je = await createManualEntry(ctx, {
      date: d('2026-01-04'),
      description: 'Typo entry',
      lines: [
        { accountId: acct['6300'], debit: '25.00' },
        { accountId: acct['1000'], credit: '25.00' },
      ],
    });
    await voidOrDeleteEntryTransaction(ctx, je.id, 'delete');
    expect(await glBalance(acct['6300'])).toBe('0.00');
    await expect(voidOrDeleteEntryTransaction(ctx, je.id, 'void')).rejects.toBeTruthy();
  });

  it('shortcut letters are one piece of text (no "P revious" in flex buttons) and Registers is in Simple mode', () => {
    const html = renderToStaticMarkup(createElement('button', { className: 'flex gap-1' }, createElement(AccessKeyText, { text: 'Previous', accessKey: 'p' })));
    expect(html).toBe('<button class="flex gap-1"><span><u class="underline decoration-1 underline-offset-2">P</u>revious</span></button>');
    const banking = simpleNavGroups.find((g) => g.heading === 'Banking')!;
    expect(banking.links.map((l) => l.label)).toContain('Registers');
  });
});
