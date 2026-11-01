/**
 * prefsperms: review-round-5 leftovers on companies.settings (security -> company / preferences).
 *
 *  1. Lost update: updatePasswordPolicy and the file password (fileLock writeLock) read the
 *     settings object, awaited other work, then wrote the WHOLE object back — a Preferences save,
 *     Set Closing Date or another policy change made in between was silently undone. They now merge
 *     only their own key in SQL. The race is made deterministic with a database wrapper that runs
 *     a competing write right before their UPDATE executes.
 *  2. updateCompany wrote the whole settings object (old and new) into the audit trail on every
 *     Preferences save. It now audits only the keys that were saved, as setClosingDate does — the
 *     audit trail (which travels with exports and copies) never repeats unrelated settings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-company');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'prefsperms-company-secret';

import { closeDb, getDb, type DB } from '@/lib/db';
import { auditLogs, companies, users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth';
import { fullAccess } from '@/lib/permissions/model';
import { createCompany, setClosingDate, updateCompany } from './company';
import { updatePasswordPolicy } from './passwordPolicy';
import { setFilePassword } from './fileLock';
import type { ServiceContext } from './_base';

let db: DB;
let companyId: string;
let owner: string;
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext =>
  ({ db, companyId, userId: owner, access: fullAccess(), role: 'owner', ...over }) as ServiceContext;

/**
 * A db whose FIRST `update(companies)` runs `competing()` (on the real db) right before its own
 * SQL executes — exactly the moment a concurrent request would commit in between.
 */
function racingDb(real: DB, competing: () => Promise<unknown>): DB {
  let fired = false;
  const delayed = <T extends object>(q: T): T =>
    new Proxy(q, {
      get(t, p, r) {
        if (p === 'then') {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            competing().then(() => (t as unknown as PromiseLike<unknown>).then(res, rej), rej);
        }
        const v = Reflect.get(t, p, r);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown).apply(t, args);
          return out && typeof out === 'object' ? delayed(out as object) : out;
        };
      },
    });
  return new Proxy(real, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p === 'update') {
        return (table: unknown) => {
          const q = (v as (x: unknown) => object).call(t, table);
          if (table !== companies || fired) return q;
          fired = true;
          return delayed(q);
        };
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as DB;
}

async function settings(): Promise<Record<string, unknown>> {
  const [row] = await db.select({ s: companies.settings }).from(companies).where(eq(companies.id, companyId));
  return (row?.s ?? {}) as Record<string, unknown>;
}
const competingTimezone = (tz: string) => () =>
  db
    .update(companies)
    .set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('timezone', ${tz}::text)` })
    .where(eq(companies.id, companyId));

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'owner@ppc.local', name: 'Owner', passwordHash: await hashPassword('ownerPass123') })
    .returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Settings Race Co', ownerId: owner })).id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('settings writers never undo a change made in between', () => {
  it('updatePasswordPolicy keeps a Preferences change committed while it ran', async () => {
    await updatePasswordPolicy(ctx({ db: racingDb(db, competingTimezone('America/Chicago')) }), { minLength: 12 });
    const s = await settings();
    expect((s.passwordPolicy as { minLength: number }).minLength).toBe(12);
    expect(s.timezone).toBe('America/Chicago');
  });

  it('setting the file password keeps a Preferences change committed while it ran', async () => {
    await setFilePassword(racingDb(db, competingTimezone('America/Denver')), 'FilePass2026!');
    const s = await settings();
    expect((s.fileLock as { enabled: boolean }).enabled).toBe(true);
    expect(s.timezone).toBe('America/Denver');
    // …and the other way round: the policy saved above is still there.
    expect((s.passwordPolicy as { minLength: number }).minLength).toBe(12);
  });
});

describe('a Preferences save audits only what it changed', () => {
  it('no closing-date or file-lock material, no unrelated keys in the audit row', async () => {
    await setClosingDate(ctx(), { closingDate: '2026-01-31', password: 'ClosePass1' });
    await updateCompany(ctx(), { settings: { warnPastDays: 45 } });
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityType, 'company')))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    const text = JSON.stringify([row.oldValues, row.newValues]);
    expect((row.newValues as { settings: Record<string, unknown> }).settings).toEqual({ warnPastDays: 45 });
    expect(Object.keys((row.oldValues as { settings: Record<string, unknown> }).settings)).toEqual(['warnPastDays']);
    expect(text).not.toMatch(/closingDate|fileLock|passwordPolicy|timezone/);
  });

  it('a rename alone audits the name, not the settings', async () => {
    await updateCompany(ctx(), { name: 'Settings Race Co 2' });
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityType, 'company')))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(row.newValues).toEqual({ name: 'Settings Race Co 2' });
    expect(row.oldValues).toEqual({ name: 'Settings Race Co' });
  });
});
