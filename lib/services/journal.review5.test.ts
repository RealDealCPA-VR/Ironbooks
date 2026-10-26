/**
 * Round-5 review regressions (journal entries / posting engine):
 *  A. Editing the same journal entry twice at once (a double-clicked Save, two users without a
 *     version header) posts ONE replacement — the second edit is refused, never a second copy.
 *  B. PATCH /api/journal-entries/:id refuses a malformed body with 400 (it used to throw a
 *     TypeError → 500), and impossible dates are refused instead of rolling over (Feb 30 → Mar 2);
 *     so does POST /api/journal-entries/:id/reverse.
 *  C. A class from ANOTHER company in the same file can't be put on a journal line (the entry
 *     detail then showed that company's class name).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getDb, closeDb, openDb, type DB } from '@/lib/db';
import { users, companies, classes, journalEntries } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount, getAccount } from './accounts';
import { createManualEntry, getAdjustingEntries, getEntry, updateEntry } from './journal';
import { postJournalEntry } from './posting';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { PATCH as entryPATCH } from '@/app/api/journal-entries/[id]/route';
import { POST as reversePOST } from '@/app/api/journal-entries/[id]/reverse/route';
import { GET as entriesGET } from '@/app/api/journal-entries/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-journal');
let db: DB;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const req = (url: string, body: unknown, method: string) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function entry(amount: string, date = '2026-03-04') {
  return createManualEntry(ctx, {
    date: d(date),
    description: 'Accrual',
    lines: [
      { accountId: acct['6400'], debit: amount },
      { accountId: acct['1000'], credit: amount },
    ],
  });
}

describe('journal entries (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@journal.test', name: 'Jo', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review5 Journal', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['6400', 'Rent', 'expense', 'operating_expenses'],
    ] as const) {
      acct[code] = (await createAccount(ctx, { code, name, type, subtype })).id;
    }
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: two edits of the same entry at once post one replacement; the second is refused', async () => {
    const je = await entry('100.00');
    const edit = (amount: string) =>
      updateEntry(ctx, je.id, {
        date: d('2026-03-04'),
        description: `Accrual ${amount}`,
        lines: [
          { accountId: acct['6400'], debit: amount },
          { accountId: acct['1000'], credit: amount },
        ],
      });
    const results = await Promise.allSettled([edit('150.00'), edit('175.00')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ServiceError);
    expect((refused[0].reason as ServiceError).code).toBe('CONFLICT');

    // Exactly one live copy of the entry: the original is void, one replacement is posted.
    const live = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntries.sourceRef, 'manual')));
    expect(live).toHaveLength(1);
    expect((await getEntry(ctx, je.id)).status).toBe('void');
    const rent = (await getAccount(ctx, acct['6400'])).balance;
    expect(['150.00', '175.00']).toContain(rent);
  });

  it('B: PATCH refuses a malformed body or an impossible date with 400; reverse refuses Feb 30', async () => {
    const je = await entry('20.00', '2026-03-10');
    const patch = (body: unknown) => entryPATCH(req(`/api/journal-entries/${je.id}`, body, 'PATCH'), { params: Promise.resolve({ id: je.id }) });
    const good = {
      date: '2026-03-10',
      description: 'Fixed',
      lines: [
        { accountId: acct['6400'], debit: '25.00' },
        { accountId: acct['1000'], credit: '25.00' },
      ],
    };
    for (const body of [
      { ...good, lines: 'not lines' },
      { ...good, lines: [null, null] },
      { ...good, description: 42 },
      { ...good, lines: [{ accountId: acct['6400'], debit: { x: 1 } }, { accountId: acct['1000'], credit: '25.00' }] },
      { ...good, date: '2026-02-30' },
    ]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Nothing changed.
    expect((await getEntry(ctx, je.id)).status).toBe('posted');

    const rev = await reversePOST(req(`/api/journal-entries/${je.id}/reverse`, { asOfDate: '2026-02-30' }, 'POST'), {
      params: Promise.resolve({ id: je.id }),
    });
    expect(rev.status).toBe(400);

    // A well-formed edit still works.
    const res = await patch(good);
    expect(res.status).toBe(200);
  });

  it('D: the Adjusting Journal Entries report reads a constant number of queries, not 4 per entry', async () => {
    for (let i = 0; i < 25; i++) {
      await createManualEntry(ctx, {
        date: d('2026-06-30'),
        description: `Adjustment ${i}`,
        isAdjusting: true,
        lines: [
          { accountId: acct['6400'], debit: `${i + 1}.00` },
          { accountId: acct['1000'], credit: `${i + 1}.00` },
        ],
      });
    }
    const client = openDb(TEST_DIR).client;
    const spy = vi.spyOn(client, 'query');
    try {
      const report = await getAdjustingEntries(ctx, { from: d('2026-06-01'), to: d('2026-06-30') });
      expect(report.entries).toHaveLength(25);
      expect(report.totalDebit).toBe('325.00');
      expect(report.totalCredit).toBe('325.00');
      expect(report.entries[3].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
        ['6400', '4.00', null],
        ['1000', null, '4.00'],
      ]);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(10);
    } finally {
      spy.mockRestore();
    }
  });

  it('E: saving an entry whose date and amounts did not change keeps the same entry (memo / description edits)', async () => {
    const je = await createManualEntry(ctx, {
      date: d('2026-07-01'),
      description: 'Accrue rent',
      reference: 'R-1',
      lines: [
        { accountId: acct['6400'], debit: '80.00', memo: 'July' },
        { accountId: acct['1000'], credit: '80.00' },
      ],
    });
    const countBefore = (await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    const saved = await updateEntry(ctx, je.id, {
      date: d('2026-07-01'),
      description: 'Accrue rent (July)',
      reference: 'R-1a',
      lines: [
        { accountId: acct['1000'], credit: '80.00', memo: 'from checking' },
        { accountId: acct['6400'], debit: '80.00', memo: 'July rent' },
      ],
    });
    // Same entry, same number, nothing voided or added.
    expect(saved.id).toBe(je.id);
    expect(saved.entryNumber).toBe(je.entryNumber);
    const after = await getEntry(ctx, je.id);
    expect(after.status).toBe('posted');
    expect(after.description).toBe('Accrue rent (July)');
    expect(after.reference).toBe('R-1a');
    expect(after.lines.map((l) => [l.accountId, l.memo]).sort()).toEqual(
      [
        [acct['1000'], 'from checking'],
        [acct['6400'], 'July rent'],
      ].sort(),
    );
    const countAfter = (await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    expect(countAfter).toBe(countBefore);

    // A changed amount still re-posts (new entry, original void).
    const reposted = await updateEntry(ctx, je.id, {
      date: d('2026-07-01'),
      description: 'Accrue rent (July)',
      lines: [
        { accountId: acct['6400'], debit: '85.00' },
        { accountId: acct['1000'], credit: '85.00' },
      ],
    });
    expect(reposted.id).not.toBe(je.id);
    expect((await getEntry(ctx, je.id)).status).toBe('void');
  });

  it('E2: an unchanged save is still refused on/before the closing date without the password', async () => {
    const je = await createManualEntry(ctx, {
      date: d('2026-01-15'),
      description: 'Old accrual',
      lines: [
        { accountId: acct['6400'], debit: '10.00' },
        { accountId: acct['1000'], credit: '10.00' },
      ],
    });
    await db.update(companies).set({ settings: { closingDate: '2026-01-31' } }).where(eq(companies.id, ctx.companyId));
    try {
      const err = await updateEntry(ctx, je.id, {
        date: d('2026-01-15'),
        description: 'Old accrual (renamed)',
        lines: [
          { accountId: acct['6400'], debit: '10.00' },
          { accountId: acct['1000'], credit: '10.00' },
        ],
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('PERIOD_CLOSED');
      expect((await getEntry(ctx, je.id)).description).toBe('Old accrual');
    } finally {
      await db.update(companies).set({ settings: {} }).where(eq(companies.id, ctx.companyId));
    }
  });

  it('C: a class that belongs to another company is refused on a journal line', async () => {
    const [otherUser] = await db.insert(users).values({ email: 'r5-other@journal.test', name: 'Other', passwordHash: 'x' }).returning();
    const [other] = await db.insert(companies).values({ name: 'Other Co', ownerId: otherUser.id }).returning();
    const [foreignClass] = await db.insert(classes).values({ companyId: other.id, name: 'Other Co Secret Class' }).returning();
    const [ownClass] = await db.insert(classes).values({ companyId: ctx.companyId, name: 'East' }).returning();

    const err = await createManualEntry(ctx, {
      date: d('2026-03-12'),
      description: 'Tagged',
      lines: [
        { accountId: acct['6400'], debit: '5.00', classId: foreignClass.id },
        { accountId: acct['1000'], credit: '5.00' },
      ],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('VALIDATION');

    // The posting engine itself refuses it too (documents post through it).
    const err2 = await postJournalEntry(ctx, {
      date: d('2026-03-12'),
      description: 'Tagged',
      lines: [
        { accountId: acct['6400'], debit: '5.00', classId: foreignClass.id },
        { accountId: acct['1000'], credit: '5.00' },
      ],
    }).catch((e) => e);
    expect(err2).toBeInstanceOf(ServiceError);
    expect((err2 as ServiceError).code).toBe('VALIDATION');

    // The company's own class is fine.
    const ok = await createManualEntry(ctx, {
      date: d('2026-03-12'),
      description: 'Tagged',
      lines: [
        { accountId: acct['6400'], debit: '5.00', classId: ownClass.id },
        { accountId: acct['1000'], credit: '5.00' },
      ],
    });
    expect((await getEntry(ctx, ok.id)).lines[0].className).toBe('East');
  });
  it("F: the New Journal Entry window's next Entry No. follows journal entries only, not check / bill numbers", async () => {
    const outer = ctx;
    const [company] = await db.insert(companies).values({ name: 'Review5 Journal numbers', ownerId: outer.userId! }).returning();
    ctx = { db, companyId: company.id, userId: outer.userId };
    try {
      const rent = (await createAccount(ctx, { code: '6400', name: 'Rent', type: 'expense', subtype: 'operating_expenses' })).id;
      const bank = (await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' })).id;
      // A journal entry numbered 7, then a check (its entry carries check number 5001 as reference).
      await createManualEntry(ctx, {
        date: d('2026-04-01'),
        description: 'Numbered',
        reference: '7',
        lines: [
          { accountId: rent, debit: '1.00' },
          { accountId: bank, credit: '1.00' },
        ],
      });
      await postJournalEntry(ctx, {
        date: d('2026-04-02'),
        description: 'Check 5001',
        reference: '5001',
        sourceRef: `expense:${crypto.randomUUID()}`,
        lines: [
          { accountId: rent, debit: '2.00' },
          { accountId: bank, credit: '2.00' },
        ],
      });
      const res = await entriesGET(new NextRequest('http://localhost/api/journal-entries?nextNumber=1&limit=1'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nextNumber?: string };
      // The window used to work it out from the newest 100 entries of every kind: 5002.
      expect(body.nextNumber).toBe('8');
    } finally {
      ctx = outer;
    }
  });
});
