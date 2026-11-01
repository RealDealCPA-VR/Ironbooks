/**
 * Feature round (accountant team) — more review-round-5 leftovers. Each test failed before its fix:
 *  R1 Recurring detection / memorizing needed only the Lists right: a Lists-only member saw vendor
 *     names and typical bill amounts (GET /api/ai/recurring) and could memorize an auto-entering
 *     bill from any bill. The suggestions now only use the documents the member may view, and
 *     memorizing needs the document's own area (view; create for an automatic one). An automatic
 *     memorized transaction (any route) needs the right to create that kind of document.
 *  E1 The error scan checked each finding with its own query (alreadyDetected per row): the
 *     number of queries no longer grows with the number of findings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount } from '../accounts';
import { createVendor } from '../vendors';
import { createBill } from '../bills';
import { createManualEntry } from '../journal';
import { detectRecurring, memorizeSuggestion } from '../aiRecurring';
import { createTemplate } from '../recurring';
import { detectErrors } from '../errorDetection';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-feature-accountant-leftovers2');
const D = (s: string) => new Date(`${s}T00:00:00Z`);

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let vendorId: string;
const billIds: string[] = [];

function as(grant: PermissionGrant): ServiceContext {
  const access: EffectiveAccess = {
    roleKeys: ['custom'],
    permissions: normalizeGrant(grant),
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
  return { ...ctx, access };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'feat-acct2@test.local', name: 'Accountant 2', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Feature Accountant 2 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  acct.rent = (await createAccount(ctx, { code: '6610', name: 'Rent Expense', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'Landlord LLC' })).id;
  for (const day of ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01']) {
    billIds.push((await createBill(ctx, { vendorId, date: D(day), lines: [{ accountId: acct.rent, amount: '1500.00' }] })).id);
  }
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('R1: recurring suggestions and memorizing follow the document rights', () => {
  const asOf = new Date('2026-08-10T12:00:00Z');

  it('an owner sees the monthly rent bill', async () => {
    const s = await detectRecurring(ctx, asOf);
    expect(s.some((x) => x.payee === 'Landlord LLC' && x.docType === 'bill')).toBe(true);
  });

  it('a Lists-only member sees no vendor names or bill amounts', async () => {
    const s = await detectRecurring(as({ lists: ['full'] }), asOf);
    expect(s).toEqual([]);
  });

  it('a Lists-only member cannot memorize a bill', async () => {
    await expect(
      memorizeSuggestion(as({ lists: ['full'], accounting: ['full'] }), {
        docType: 'bill',
        sourceDocId: billIds[3],
        frequency: 'monthly',
        nextRunDate: '2026-09-01',
        name: 'Rent',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('memorizing an automatic bill needs the right to create bills', async () => {
    const viewer = as({ lists: ['full'], accounting: ['full'], vendors: ['view'] });
    await expect(
      memorizeSuggestion(viewer, { docType: 'bill', sourceDocId: billIds[3], frequency: 'monthly', nextRunDate: '2026-09-01', name: 'Rent auto', autoEnter: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Remind-only is fine with the view right (nothing is entered without someone who may).
    const t = await memorizeSuggestion(viewer, { docType: 'bill', sourceDocId: billIds[3], frequency: 'monthly', nextRunDate: '2026-09-01', name: 'Rent reminder' });
    expect(t.mode).toBe('remind');
  });

  it('an automatic memorized bill from /api/recurring needs the right to create bills', async () => {
    const input = {
      name: 'Auto rent',
      docType: 'bill' as const,
      frequency: 'monthly' as const,
      nextRunDate: '2026-09-01',
      mode: 'automatic' as const,
      template: { vendorId, lines: [{ accountId: acct.rent, amount: '1500.00' }] },
    };
    await expect(createTemplate(as({ lists: ['full'], accounting: ['full'] }), input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ok = await createTemplate(as({ lists: ['full'], accounting: ['full'], vendors: ['full'] }), { ...input, name: 'Auto rent 2' });
    expect(ok.mode).toBe('automatic');
  });
});

describe('E1: the error scan does not query once per finding', () => {
  async function countSelects(n: number): Promise<number> {
    // n identical entries are n "possible duplicate" findings.
    for (let i = 0; i < n; i++) {
      await createManualEntry(ctx, {
        date: D('2026-04-15'),
        description: `Same entry ${n}`,
        lines: [
          { accountId: acct.rent, debit: '10.00' },
          { accountId: acct['1000'], credit: '10.00' },
        ],
      });
    }
    let selects = 0;
    const counted = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === 'select' && typeof v === 'function') {
          return (...args: unknown[]) => {
            selects++;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as DB;
    await detectErrors({ ...ctx, db: counted });
    return selects;
  }

  it('a scan with many findings runs as many queries as one with few', async () => {
    const few = await countSelects(2);
    const many = await countSelects(25);
    expect(many).toBeLessThanOrEqual(few);
  });
});
