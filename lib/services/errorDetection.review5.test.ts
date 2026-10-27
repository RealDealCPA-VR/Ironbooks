/**
 * Review round 5 — the error scan's findings (each failed before its fix):
 *  A  an "unusually large amount" finding names the account ("6110 · R5 Fuel"), not its internal
 *     id — the text is shown as is on the AI Review screen and in Needs Attention;
 *  B  voided and draft entries are not reported as "missing a description": they are not in the
 *     books, and voiding one could never make the finding go away.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createManualEntry } from './journal';
import { detectErrors } from './errorDetection';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-error-detection');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T12:00:00Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-errscan@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review5 Scan Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  acct.fuel = (await createAccount(ctx, { code: '6110', name: 'R5 Fuel', type: 'expense' as never, subtype: 'operating_expenses' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('review5: error scan findings', () => {
  it('A: an outlier names its account', async () => {
    const amounts = ['40.00', '42.00', '38.00', '41.00', '39.00', '40.00', '43.00', '37.00', '40.00', '41.00', '39.00', '4000.00'];
    for (const [i, amt] of amounts.entries()) {
      await createManualEntry(ctx, {
        date: D(`2026-02-${String(i + 1).padStart(2, '0')}`),
        description: `Fuel ${i + 1}`,
        lines: [
          { accountId: acct.fuel, debit: amt },
          { accountId: acct['1000'], credit: amt },
        ],
      });
    }
    const found = (await detectErrors(ctx)).filter((d) => d.errorType === 'unusual_pattern' && d.description.includes('4000.00'));
    expect(found.length).toBeGreaterThan(0);
    const onFuel = found.find((d) => d.description.includes('R5 Fuel'));
    expect(onFuel?.description).toContain('6110 · R5 Fuel');
    for (const d of found) expect(d.description).not.toContain(acct.fuel);
  });

  it('B: a voided entry without a description is not a finding', async () => {
    const entry = await db.transaction(async (tx) => {
      const [e] = await tx
        .insert(journalEntries)
        .values({ companyId: ctx.companyId, entryNumber: 99001, date: D('2026-03-05'), description: '  ', status: 'void', createdBy: ctx.userId })
        .returning();
      await tx.insert(journalEntryLines).values([
        { journalEntryId: e.id, accountId: acct['1000'], debit: '10.00', credit: null },
        { journalEntryId: e.id, accountId: acct['3000'], debit: null, credit: '10.00' },
      ]);
      return e;
    });
    const found = (await detectErrors(ctx)).filter((d) => d.journalEntryId === entry.id);
    expect(found).toEqual([]);
  });
});
