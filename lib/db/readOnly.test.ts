/**
 * The read-only database handle (lib/db/readOnly.ts): the barrier under an agent that does not
 * depend on any service remembering to check. Reads work; every way of writing is refused,
 * including a raw statement and a write inside a transaction, where the database itself says no.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-readonly-db');

import { getDb, closeDb, type DB } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { companies, users } from '@/lib/db/schema';
import { ServiceError } from '@/lib/services/errors';
import { READ_ONLY_MESSAGE, isReadOnlyDb, readOnlyDb } from './readOnly';

let db: DB;
let ro: DB;
let ownerId: string;

async function expectRefused(run: () => unknown) {
  let err: unknown;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  expect(err, 'the write went through').toBeTruthy();
  return err;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'ro@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  ownerId = owner.id;
  await db.insert(companies).values({ name: 'Read Only Co', ownerId });
  ro = readOnlyDb(db);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('readOnlyDb', () => {
  it('reads like the real handle', async () => {
    expect(isReadOnlyDb(ro)).toBe(true);
    expect(isReadOnlyDb(db)).toBe(false);
    expect(readOnlyDb(ro)).toBe(ro);
    const rows = await ro.select({ name: companies.name }).from(companies);
    expect(rows).toEqual([{ name: 'Read Only Co' }]);
    const found = await ro.query.users.findFirst({ where: eq(users.id, ownerId) });
    expect(found?.name).toBe('Owner');
    const raw = (await ro.execute(sql`select count(*)::int as n from companies`)) as unknown as { rows: Array<{ n: number }> };
    expect(raw.rows[0].n).toBe(1);
    // Services still find the company file's side files through the wrapper.
    expect(dataDirOf(ro)).toBe(dataDirOf(db));
  });

  it('reads inside a transaction, and inside a nested one', async () => {
    const n = await ro.transaction(async (tx) => {
      expect(isReadOnlyDb(tx)).toBe(true);
      const outer = await tx.select({ id: companies.id }).from(companies);
      const inner = await tx.transaction(async (tx2) => (await tx2.select({ id: users.id }).from(users)).length);
      return outer.length + inner;
    });
    expect(n).toBe(2);
  });

  it('refuses insert, update and delete before anything reaches the database', async () => {
    for (const run of [
      () => ro.insert(companies).values({ name: 'Nope', ownerId }),
      () => ro.update(companies).set({ name: 'Changed' }),
      () => ro.delete(companies),
    ]) {
      const err = await expectRefused(run);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('FORBIDDEN');
      expect((err as ServiceError).message).toBe(READ_ONLY_MESSAGE);
    }
  });

  it('refuses a raw statement that writes', async () => {
    await expectRefused(() => ro.execute(sql`update companies set name = 'Raw'`));
    await expectRefused(() => ro.execute(sql`insert into companies (name, owner_id) values ('Raw', ${ownerId})`));
    await expectRefused(() => ro.execute(sql`delete from companies`));
    await expectRefused(() => ro.execute(sql`create table sneaky (id int)`));
  });

  it('refuses a write inside a transaction, by any route', async () => {
    await expectRefused(() => ro.transaction((tx) => tx.insert(companies).values({ name: 'Tx', ownerId })));
    await expectRefused(() => ro.transaction((tx) => tx.execute(sql`update companies set name = 'Tx raw'`)));
    await expectRefused(() => ro.transaction((tx) => tx.transaction((tx2) => tx2.execute(sql`delete from companies`))));
    // WITH … can lead into a write on the real handle; here it only selects.
    const cte = ro.$with('c').as(ro.select({ id: companies.id }).from(companies));
    const viaCte = ro.with(cte) as unknown as Record<string, unknown>;
    expect(typeof viaCte.select).toBe('function');
    expect(viaCte.insert).toBeUndefined();
    expect(viaCte.update).toBeUndefined();
    expect(viaCte.delete).toBeUndefined();
  });

  it('refuses whatever it does not know, and cannot be altered', async () => {
    const anyRo = ro as unknown as Record<string, unknown>;
    await expectRefused(() => (anyRo.refreshMaterializedView as () => unknown)());
    await expectRefused(() => (anyRo.$client as () => unknown)());
    await expectRefused(() => {
      anyRo.insert = () => 'patched';
    });
    expect(anyRo.then).toBeUndefined();
  });

  it('left the books exactly as they were', async () => {
    expect(await db.select({ name: companies.name }).from(companies)).toEqual([{ name: 'Read Only Co' }]);
    const tables = (await db.execute(sql`select count(*)::int as n from information_schema.tables where table_name = 'sneaky'`)) as unknown as { rows: Array<{ n: number }> };
    expect(tables.rows[0].n).toBe(0);
  });
});
