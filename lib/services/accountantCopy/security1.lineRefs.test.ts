/**
 * Security (small) — resolveLineRef with an owner type from an imported changes file
 * (lib/services/accountantCopy/lineRefs.ts).
 *
 * OWNER_TABLES[type] with type "constructor" or "__proto__" found Object's own members, which
 * then went into the SQL as a table name (sql.raw): a crafted file made the import fail with a
 * database error. Only the table's own keys count now; anything else is not an owner.
 */
import { describe, it, expect } from 'vitest';
import type { ServiceContext } from '../_base';
import { resolveLineRef } from './lineRefs';
import type { LineRef } from './format';

/** A stand-in database: every query finds nothing; raw SQL statements are recorded. */
function fakeDb() {
  const executed: unknown[] = [];
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? (resolve: (v: unknown) => void) => resolve([]) : () => chain),
    apply: () => chain,
  });
  const db = { select: () => chain, execute: async (q: unknown) => (executed.push(q), { rows: [] }) };
  return { db: db as unknown as ServiceContext['db'], executed };
}

const ref = (type: string): LineRef => ({
  lineId: '00000000-0000-4000-8000-000000000001',
  entryId: '00000000-0000-4000-8000-000000000002',
  sourceRef: 'manual',
  date: '2026-01-15',
  accountId: '00000000-0000-4000-8000-000000000003',
  debit: '10.00',
  credit: null,
  entityId: null,
  owner: { type, id: '00000000-0000-4000-8000-000000000004' },
});

describe('resolveLineRef owner types', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('"%s" is not an owner table', async (type) => {
    const { db, executed } = fakeDb();
    await expect(resolveLineRef({ db, companyId: '00000000-0000-4000-8000-0000000000aa' }, ref(type), new Map(), new Map())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(executed).toEqual([]);
  });

  it('a real owner type still looks up its table', async () => {
    const { db, executed } = fakeDb();
    await expect(resolveLineRef({ db, companyId: '00000000-0000-4000-8000-0000000000aa' }, ref('invoice'), new Map(), new Map())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(executed).toHaveLength(1);
  });
});
