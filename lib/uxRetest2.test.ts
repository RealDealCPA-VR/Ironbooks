/**
 * Independent QA, re-test round 2 for team/ux.
 *
 * Verifies the round-1 fixes in lib/journalBalance.ts (comma-as-decimal is invalid; amounts
 * over numeric(15,2) are blocked) end to end, and probes what the new cap does NOT cover:
 * the exact boundary posting through the real ledger, the cached account balance
 * (accounts.balance is also numeric(15,2)) overflowing on a second max-size entry, rollback
 * after such a failure, and comma/locale variants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, users } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { createCompany } from '@/lib/services/company';
import { createAccount } from '@/lib/services/accounts';
import { createManualEntry } from '@/lib/services/journal';
import { trialBalance } from '@/lib/services/reports';
import { createJournalEntrySchema } from '@/lib/validation/journal';
import { computeJournalBalance, journalPayloadAmount, normalizeAmount, type JournalLineInput } from './journalBalance';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ux-retest2');
let db: DB;
let ctx: ServiceContext;
let bigAsset: string;
let bigEquity: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'ux-retest2@test.local', name: 'UX Retest 2', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'UX Retest2 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  // Fresh zero-balance accounts so the boundary test is not polluted by other postings.
  bigAsset = (await createAccount(ctx, { code: '1999', name: 'Boundary Asset', type: 'asset', subtype: '' } as never)).id;
  bigEquity = (await createAccount(ctx, { code: '3999', name: 'Boundary Equity', type: 'equity', subtype: '' } as never)).id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function pagePayload(lines: JournalLineInput[]) {
  return {
    date: '2026-04-01',
    description: 'Retest2 entry',
    reference: null,
    lines: lines
      .filter((l) => l.accountId)
      .map((l) => ({
        accountId: l.accountId,
        debit: journalPayloadAmount(l.debit),
        credit: journalPayloadAmount(l.credit),
        memo: null,
        classId: null,
      })),
  };
}

async function postLikeThePage(lines: JournalLineInput[]) {
  const parsed = createJournalEntrySchema.safeParse(pagePayload(lines));
  if (!parsed.success) throw new Error(`schema rejected: ${parsed.error.issues[0]?.message}`);
  return createManualEntry(ctx, parsed.data);
}

async function balanceOf(id: string) {
  const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id));
  return String(row.balance);
}

describe('round-1 fixes, verified', () => {
  it('comma-as-decimal and European formats stay invalid; their payload is never a silently scaled number', () => {
    for (const bad of ['12,50', '1,2,3', '1.250,00', '1,250,00', '1,250.505', '1,,250', '1,250.', ',250']) {
      const bal = computeJournalBalance([
        { accountId: 'a', debit: bad, credit: '' },
        { accountId: 'b', debit: '', credit: bad },
      ]);
      expect(bal.canSave, bad).toBe(false);
      expect(bal.invalidLines, bad).toEqual([1, 2]);
      // Whatever normalizeAmount returns must not pass the server's money regex either.
      const parsed = createJournalEntrySchema.safeParse(
        pagePayload([
          { accountId: '00000000-0000-4000-8000-000000000001', debit: bad, credit: '' },
          { accountId: '00000000-0000-4000-8000-000000000002', debit: '', credit: '1' },
        ]),
      );
      expect(parsed.success, `API would accept ${bad} as ${normalizeAmount(bad)}`).toBe(false);
    }
  });

  it('the exact ledger limit (typed with separators and spaces) posts through the real ledger and stays balanced', async () => {
    const max = ' 9,999,999,999,999.99 ';
    const lines = [
      { accountId: bigAsset, debit: max, credit: '' },
      { accountId: bigEquity, debit: '', credit: '9999999999999.99' },
    ];
    expect(computeJournalBalance(lines).canSave).toBe(true);
    await expect(postLikeThePage(lines)).resolves.toBeTruthy();
    expect(await balanceOf(bigAsset)).toMatch(/^9999999999999\.99$/);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('one cent over the limit, on a line or as a side total, is blocked', () => {
    const line = computeJournalBalance([
      { accountId: 'a', debit: '10,000,000,000,000.00', credit: '' },
      { accountId: 'b', debit: '', credit: '10000000000000' },
    ]);
    expect(line.canSave).toBe(false);
    expect(line.blocker).toMatch(/too large/);
    const total = computeJournalBalance([
      { accountId: 'a', debit: '9999999999999.99', credit: '' },
      { accountId: 'a', debit: '0.01', credit: '' },
      { accountId: 'b', debit: '', credit: '9999999999999.99' },
      { accountId: 'b', debit: '', credit: '0.01' },
    ]);
    expect(total.canSave).toBe(false);
    expect(total.blocker).toMatch(/total .* too large/);
  });

  it('leading zeros do not trip the cap (value, not string length, is what counts)', () => {
    const bal = computeJournalBalance([
      { accountId: 'a', debit: '000000000000125.00', credit: '' },
      { accountId: 'b', debit: '', credit: '125' },
    ]);
    expect(bal.canSave).toBe(true);
  });
});

describe('what the per-entry cap cannot see: the cached account balance', () => {
  // Fixed in integration: the database layer translates SQLSTATE 22003 (the cached balance
  // overflowing numeric(15,2) inside the ledger trigger) into a VALIDATION ServiceError
  // (lib/db/pgErrors.ts), and the transaction still rolls back.
  // Split in two so the accounting invariant (clean rollback) is enforced as a normal passing
  // test, while the missing friendly error stays a plain (red) test until fixed -- QA round 3.
  const overflowLines = () => [
    { accountId: bigAsset, debit: '1.00', credit: '' },
    { accountId: bigEquity, debit: '', credit: '1.00' },
  ];
  async function attemptOverflow(): Promise<unknown> {
    try {
      await postLikeThePage(overflowLines());
      return null;
    } catch (e) {
      return e;
    }
  }

  it('a second max-size entry into the same account is refused and rolls back cleanly', async () => {
    // accounts.balance is numeric(15,2) too. The gate (correctly) allows this entry on its own,
    // but the account already holds 9,999,999,999,999.99 from the boundary test above.
    const before = await balanceOf(bigAsset);
    const entriesBefore = (await db.select({ id: journalEntries.id }).from(journalEntries)).length;
    expect(computeJournalBalance(overflowLines()).canSave).toBe(true);
    const err = await attemptOverflow();
    expect(err, 'entry overflowing the account balance was accepted').not.toBeNull();
    expect(await balanceOf(bigAsset)).toBe(before);
    expect((await db.select({ id: journalEntries.id }).from(journalEntries)).length).toBe(entriesBefore);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('the overflow surfaces as a friendly ServiceError, not a raw 22003', async () => {
    const err = await attemptOverflow();
    expect(err instanceof ServiceError, `raw error reached the route: ${String(err)}`).toBe(true);
    expect((err as ServiceError).code).toBe('VALIDATION');
    expect((err as ServiceError).message).toMatch(/too large/i);
  });
});
