/**
 * Central Postgres → ServiceError translation (lib/db/pgErrors.ts) and amount parsing guards
 * (lib/money.ts, posting validation): malformed ids answer 404, malformed / overflowing amounts
 * answer 400 — never a raw 22P02 / 22003 / DecimalError (HTTP 500).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, users } from '@/lib/db/schema';
import { translatePgError } from './pgErrors';
import { ServiceError } from '@/lib/services/errors';
import { ServiceError as BaseServiceError, type ServiceContext } from '@/lib/services/_base';
import { Money, MoneyParseError, toAmountString } from '@/lib/money';
import { assertBalanced, postJournalEntry } from '@/lib/services/posting';
import { createAccount } from '@/lib/services/accounts';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-pg-errors');
let db: DB;
let ctx: ServiceContext;

describe('translatePgError (pure)', () => {
  it('maps a malformed uuid to NOT_FOUND and other 22P02 input to VALIDATION', () => {
    const uuid = translatePgError({ code: '22P02', message: 'invalid input syntax for type uuid: "x"' });
    expect(uuid).toMatchObject({ code: 'NOT_FOUND' });
    const num = translatePgError({ code: '22P02', message: 'invalid input syntax for type numeric: "x"' });
    expect(num).toMatchObject({ code: 'VALIDATION' });
  });

  it('maps numeric overflow to a friendly VALIDATION error and leaves other errors alone', () => {
    expect(translatePgError({ code: '22003', message: 'numeric field overflow' })).toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/too large/),
    });
    const other = { code: '23505', message: 'duplicate key' };
    expect(translatePgError(other)).toBe(other);
  });

  it('_base re-exports the same ServiceError class', () => {
    expect(BaseServiceError).toBe(ServiceError);
  });
});

describe('amount parsing', () => {
  it('ignores surrounding whitespace of any kind', () => {
    expect(toAmountString(' 7.25 ')).toBe('7.25');
    expect(toAmountString('\t7.25 ')).toBe('7.25');
    expect(toAmountString('  ')).toBe('0.00');
  });

  it('throws MoneyParseError (not a DecimalError) for garbage', () => {
    expect(() => Money.of('7,25x')).toThrow(MoneyParseError);
  });

  it('posting validation turns garbage / NaN / huge amounts into VALIDATION', () => {
    const line = (debit: string) => [
      { accountId: 'a', debit, credit: null },
      { accountId: 'b', debit: null, credit: '1.00' },
    ];
    for (const bad of ['abc', 'NaN', 'Infinity', '10000000000000.00']) {
      expect(() => assertBalanced(line(bad)), bad).toThrow(ServiceError);
      try {
        assertBalanced(line(bad));
      } catch (e) {
        expect((e as ServiceError).code, bad).toBe('VALIDATION');
      }
    }
  });
});

describe('against a real company database', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'pg@errors.test', name: 'PG', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'PG Errors Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a malformed id in a query is NOT_FOUND, inside or outside a transaction', async () => {
    await expect(db.select().from(accounts).where(eq(accounts.id, 'garbage'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      db.transaction(async (tx) => tx.select().from(accounts).where(eq(accounts.id, 'nope'))),
    ).rejects.toBeInstanceOf(ServiceError);
    // The connection is still usable afterwards.
    const ok = await db.execute(sql`select 1 as one`);
    expect(ok).toBeTruthy();
  });

  it('posting into an account whose cached balance would overflow is VALIDATION and rolls back', async () => {
    const big = await createAccount(ctx, { code: '1999', name: 'Big', type: 'asset', subtype: 'checking' });
    const eqty = await createAccount(ctx, { code: '3999', name: 'Eq', type: 'equity', subtype: 'owners_equity' });
    const max = '9999999999999.99';
    await postJournalEntry(ctx, {
      date: new Date('2026-01-01'),
      description: 'max',
      lines: [
        { accountId: big.id, debit: max, credit: null },
        { accountId: eqty.id, debit: null, credit: max },
      ],
    });
    await expect(
      postJournalEntry(ctx, {
        date: new Date('2026-01-02'),
        description: 'overflow',
        lines: [
          { accountId: big.id, debit: '1.00', credit: null },
          { accountId: eqty.id, debit: null, credit: '1.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/too large/) });
    const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, big.id));
    expect(row.balance).toBe(max);
  });

  it('" 7.25 " posts as 7.25', async () => {
    const a = await createAccount(ctx, { code: '1001', name: 'Cash', type: 'asset', subtype: 'checking' });
    const b = await createAccount(ctx, { code: '4001', name: 'Sales', type: 'revenue', subtype: 'sales' });
    const entry = await postJournalEntry(ctx, {
      date: new Date('2026-02-01'),
      description: 'spaces',
      lines: [
        { accountId: a.id, debit: ' 7.25 ', credit: null },
        { accountId: b.id, debit: null, credit: '7.25' },
      ],
    });
    expect(entry).toBeTruthy();
    const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, a.id));
    expect(row.balance).toBe('7.25');
  });
});
