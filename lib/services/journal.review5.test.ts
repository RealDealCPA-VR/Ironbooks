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
});
