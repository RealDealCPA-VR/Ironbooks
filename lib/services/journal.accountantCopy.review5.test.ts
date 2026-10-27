/**
 * Round-5 review regression (journal entries x Accountant's Copy):
 *  An edit that changes only a journal entry's description, line memo, Entry No. or Adjusting flag
 *  keeps the SAME entry (lib/services/journal.ts updateEntry, round 5). The Accountant's Copy
 *  changes file only spotted journal-entry edits through the void + re-post link, so such an
 *  accountant edit never reached the client: it was silently lost on import.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { asc, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createManualEntry, updateEntry } from './journal';
import { trialBalance } from './reports';
import { createAccountantCopy, importChangesFile, reviewChangesFile } from './accountantCopy/client';
import { accountantChanges, exportChangesFile, openAccountantCopyFile } from './accountantCopy/accountant';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-journal-acctcopy');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

let db: DB;
let ctx: ServiceContext;
let adb: DB;
let actx: ServiceContext;
const acct: Record<string, string> = {};

async function header(c: ServiceContext, id: string) {
  const [e] = await c.db.select().from(journalEntries).where(eq(journalEntries.id, id));
  const lines = await c.db
    .select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit, memo: journalEntryLines.memo })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, id))
    .orderBy(asc(journalEntryLines.createdAt), asc(journalEntryLines.id));
  // Debit lines first (lines inserted together share createdAt).
  lines.sort((a, b) => Number(Boolean(b.debit)) - Number(Boolean(a.debit)));
  return { status: e.status, description: e.description, reference: e.reference, isAdjusting: e.isAdjusting, lines };
}

describe("journal entries in an Accountant's Copy (review round 5)", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@je-acctcopy.test', name: 'Client Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R5 Copy Client', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  });

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    try {
      fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it("A: the accountant's description / memo / Entry No. / Adjusting edit of a client entry travels and is applied on import", async () => {
    const lines = (memo: string | null) => [
      { accountId: acct['6300'], debit: '100.00', memo },
      { accountId: acct['1000'], credit: '100.00' },
    ];
    const edited = await createManualEntry(ctx, { date: d('2026-02-15'), description: 'Office supplies', reference: '12', lines: lines(null) });
    const untouched = await createManualEntry(ctx, { date: d('2026-02-20'), description: 'Postage', reference: '13', lines: lines(null) });

    const copy = await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR });
    await openAccountantCopyFile(copy.buffer, ACCT_DIR);
    adb = await getDb(ACCT_DIR);
    actx = { db: adb, companyId: ctx.companyId, userId: ctx.userId };

    // Header-only edit on the accountant side: same date, same accounts and amounts.
    const saved = await updateEntry(actx, edited.id, {
      date: d('2026-02-15'),
      description: 'Office supplies (per Staples invoice)',
      reference: '12A',
      isAdjusting: true,
      lines: lines('Staples #4411'),
    });
    expect(saved.id).toBe(edited.id); // the same entry, edited in place

    const changes = await accountantChanges(actx);
    expect(changes.transactions.map((t) => `${t.type}:${t.op}`)).toEqual(['journal_entry:edit']);
    const t = changes.transactions[0];
    expect(t.id).toBe(edited.id);
    expect(t.op === 'edit' && t.type === 'journal_entry' && t.after).toMatchObject({
      description: 'Office supplies (per Staples invoice)',
      reference: '12A',
      isAdjusting: true,
    });

    const out = await exportChangesFile(actx, { note: 'Recoded the memo.' });
    const review = await reviewChangesFile(ctx, out.buffer);
    expect(review.canImport).toBe(true);
    expect(review.counts.changed).toBe(1);

    const tbBefore = await trialBalance(ctx);
    const res = await importChangesFile(ctx, out.buffer);
    expect(res.applied.changed).toBe(1);

    // The client's entry now carries the accountant's header and memo — still the same entry.
    expect(await header(ctx, edited.id)).toEqual({
      status: 'posted',
      description: 'Office supplies (per Staples invoice)',
      reference: '12A',
      isAdjusting: true,
      lines: [
        { accountId: acct['6300'], debit: '100.00', credit: null, memo: 'Staples #4411' },
        { accountId: acct['1000'], debit: null, credit: '100.00', memo: null },
      ],
    });
    // The other entry and the balances are untouched.
    expect((await header(ctx, untouched.id)).description).toBe('Postage');
    const tbAfter = await trialBalance(ctx);
    expect(tbAfter.balanced).toBe(true);
    expect(tbAfter.rows.map((r) => [r.code, r.debit, r.credit])).toEqual(tbBefore.rows.map((r) => [r.code, r.debit, r.credit]));
  });
});
