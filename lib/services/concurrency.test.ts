/**
 * Optimistic concurrency (multi-user mode): two people edit the same record; the second save
 * must be refused with 409 CONFLICT naming who changed it, and nothing it would have written
 * may land. Also: journal-entry edits stay balanced, and saves without a version still work.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers as customersTable, journalEntries } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createCustomer, getCustomer, updateCustomer } from './customers';
import { postJournalEntry } from './posting';
import { getEntry, updateEntry } from './journal';
import { trialBalance } from './reports';
import { assertCurrentVersion, expectedVersion, withVersionCheck, EXPECTED_VERSION_HEADER } from './concurrency';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency');
let db: DB;
let alice: ServiceContext;
let bob: ServiceContext;
const acct: Record<string, string> = {};

describe('optimistic concurrency', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [ua] = await db.insert(users).values({ email: 'alice@test.local', name: 'Alice', passwordHash: 'x' }).returning();
    const [ub] = await db.insert(users).values({ email: 'bob@test.local', name: 'Bob', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Concurrency Co', ownerId: ua.id }).returning();
    alice = { db, companyId: company.id, userId: ua.id };
    bob = { db, companyId: company.id, userId: ub.id };
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['6000', 'Office Expense', 'expense', 'operating_expenses'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ] as const) {
      acct[code] = (await createAccount(alice, { code, name, type, subtype })).id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('reads the expected version from the request header', () => {
    const req = new Request('http://x', { headers: { [EXPECTED_VERSION_HEADER]: '2026-01-02T03:04:05.006Z' } });
    expect(expectedVersion(req)?.toISOString()).toBe('2026-01-02T03:04:05.006Z');
    expect(expectedVersion(new Request('http://x'))).toBeNull();
    expect(expectedVersion(new Request('http://x', { headers: { [EXPECTED_VERSION_HEADER]: 'garbage' } }))).toBeNull();
  });

  it('second stale save gets 409 naming who changed it; its changes are not applied', async () => {
    const created = await createCustomer(alice, { displayName: 'Acme Ltd' });
    // Both users open the record.
    const loadedByAlice = (await getCustomer(alice, created.id)).updatedAt;
    const loadedByBob = (await getCustomer(bob, created.id)).updatedAt;
    expect(loadedByAlice.getTime()).toBe(loadedByBob.getTime());

    // Alice saves first (round-tripped through JSON like the UI does).
    await withVersionCheck(alice, 'customer', created.id, loadedByAlice.toISOString(), (c) =>
      updateCustomer(c, created.id, { displayName: 'Acme Limited' }),
    );

    // Bob saves from his stale copy.
    const err = await withVersionCheck(bob, 'customer', created.id, loadedByBob.toISOString(), (c) =>
      updateCustomer(c, created.id, { displayName: 'ACME (Bob)' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/^This record was changed by Alice at .+\. Reload to see the latest\.$/);
    expect((err.details as { changedBy: string }).changedBy).toBe('Alice');

    const [row] = await db.select().from(customersTable).where(eq(customersTable.id, created.id));
    expect(row.displayName).toBe('Acme Limited');

    // After reloading, Bob's save goes through.
    const fresh = (await getCustomer(bob, created.id)).updatedAt;
    await withVersionCheck(bob, 'customer', created.id, fresh.toISOString(), (c) =>
      updateCustomer(c, created.id, { displayName: 'ACME (Bob)' }),
    );
    expect((await getCustomer(alice, created.id)).displayName).toBe('ACME (Bob)');
  });

  it('every checked save advances the version, even within the same millisecond', async () => {
    const c = await createCustomer(alice, { displayName: 'Same-ms Co' });
    let v = (await getCustomer(alice, c.id)).updatedAt;
    for (let i = 0; i < 3; i++) {
      await withVersionCheck(alice, 'customer', c.id, v, (cx) => updateCustomer(cx, c.id, { notes: `n${i}` }));
      const next = (await getCustomer(alice, c.id)).updatedAt;
      expect(next.getTime()).toBeGreaterThan(v.getTime());
      // The previous version is now stale.
      await expect(assertCurrentVersion(alice, 'customer', c.id, v)).rejects.toMatchObject({ code: 'CONFLICT' });
      v = next;
    }
  });

  it('a save with no version (older page / script) is unchanged: last write wins', async () => {
    const c = await createCustomer(alice, { displayName: 'Legacy Co' });
    await withVersionCheck(bob, 'customer', c.id, null, (cx) => updateCustomer(cx, c.id, { displayName: 'Legacy 2' }));
    expect((await getCustomer(alice, c.id)).displayName).toBe('Legacy 2');
  });

  it('records from another company are NOT_FOUND, never compared', async () => {
    const c = await createCustomer(alice, { displayName: 'Tenant Co' });
    const outsider = { ...bob, companyId: '00000000-0000-0000-0000-000000000000' };
    await expect(assertCurrentVersion(outsider, 'customer', c.id, new Date())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('journal entry: a stale edit is refused and the books stay balanced', async () => {
    const entry = await postJournalEntry(alice, {
      date: new Date('2026-03-01'),
      description: 'Supplies',
      status: 'posted',
      sourceRef: 'manual',
      lines: [
        { accountId: acct['6000'], debit: '100.00' },
        { accountId: acct['1000'], credit: '100.00' },
      ],
    });
    const v0 = (await getEntry(alice, entry.id)).updatedAt;
    const edit = (amount: string) => ({
      date: new Date('2026-03-01'),
      description: 'Supplies (edited)',
      lines: [
        { accountId: acct['6000'], debit: amount },
        { accountId: acct['1000'], credit: amount },
      ],
    });

    const replacement = await withVersionCheck(alice, 'journal_entry', entry.id, v0, (c) =>
      updateEntry(c, entry.id, edit('120.00')),
    );
    expect(replacement.id).not.toBe(entry.id);

    await expect(
      withVersionCheck(bob, 'journal_entry', entry.id, v0, (c) => updateEntry(c, entry.id, edit('999.00'))),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const posted = await db.select().from(journalEntries).where(eq(journalEntries.companyId, alice.companyId));
    expect(posted.filter((e) => e.status === 'posted').length).toBe(1);
    const tb = await trialBalance(alice);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
