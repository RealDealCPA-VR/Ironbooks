/**
 * drizzle-orm 0.44+ wraps query errors in DrizzleQueryError; the app relies on the database's own
 * error (lib/db/driverErrors.ts). A drizzle instance on PGlite, through every way the app runs a
 * statement (query builder, db.execute, inside a transaction, the migrator's statements), must
 * throw what Postgres (or the translating client) threw — its code intact, no SQL or parameter
 * values in the message.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { DrizzleQueryError, eq, sql } from 'drizzle-orm';
import { pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { driverError, driverErrorsInstalled } from './driverErrors';
import '@/lib/db'; // installs it, as every server process does
import { translatePgErrors } from './pgErrors';
import { ServiceError } from '@/lib/services/errors';

const things = pgTable('things', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 5 }).notNull(),
});

let client: PGlite;

beforeAll(async () => {
  client = translatePgErrors(new PGlite());
  await client.exec('CREATE TABLE things (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(5) NOT NULL UNIQUE)');
});

afterAll(async () => {
  await client.close();
});

describe('query errors are the database’s own', () => {
  it('is installed by lib/db', () => {
    expect(driverErrorsInstalled()).toBe(true);
  });

  it('a raw Postgres error keeps its code and carries no statement or values', async () => {
    const db = drizzle(new PGlite());
    const err = await db.execute(sql`select * from no_such_table where secret = ${'s3cret'}`).catch((e) => e);
    expect(err).not.toBeInstanceOf(DrizzleQueryError);
    expect(err).toMatchObject({ code: '42P01' });
    expect(String(err.message)).not.toMatch(/Failed query|s3cret/);
  });

  it('a ServiceError from the translating client comes through as itself (query builder, execute, transaction)', async () => {
    const db = drizzle(client);
    // Malformed uuid → NOT_FOUND; text longer than varchar(5) → VALIDATION (lib/db/pgErrors.ts).
    const select = await db.select().from(things).where(eq(things.id, 'garbage')).catch((e) => e);
    expect(select).toBeInstanceOf(ServiceError);
    expect(select).toMatchObject({ code: 'NOT_FOUND' });
    const insert = await db.insert(things).values({ name: 'much too long' }).catch((e) => e);
    expect(insert).toBeInstanceOf(ServiceError);
    expect(insert).toMatchObject({ code: 'VALIDATION' });
    const inTx = await db
      .transaction(async (tx) => {
        await tx.insert(things).values({ name: 'a' });
        await tx.insert(things).values({ name: 'a' }); // unique violation, untranslated
      })
      .catch((e) => e);
    expect(inTx).not.toBeInstanceOf(DrizzleQueryError);
    expect(inTx).toMatchObject({ code: '23505' });
    expect(await db.select().from(things)).toEqual([]); // rolled back
  });

  it('driverError unwraps only drizzle query errors', () => {
    const pgErr = Object.assign(new Error('boom'), { code: '23503' });
    expect(driverError(new DrizzleQueryError('select 1', [], pgErr))).toBe(pgErr);
    const other = new Error('other');
    expect(driverError(other)).toBe(other);
    const noCause = new DrizzleQueryError('select 1', []);
    expect(driverError(noCause)).toBe(noCause);
  });
});
