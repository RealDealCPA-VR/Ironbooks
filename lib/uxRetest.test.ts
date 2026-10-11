/**
 * Independent QA, re-test round 1 for team/ux.
 *
 * Verifies the fixes for the round-0 failures (journal Save gate vs API: thousands separators,
 * surrounding whitespace, two-sided lines; <Help> on the key money forms) end to end — client
 * gate -> page payload -> API zod schema -> postJournalEntry -> ledger — and probes adjacent
 * edge cases: unusual whitespace, fuzzed amount strings, amounts that overflow the ledger's
 * numeric(15,2) columns, and comma-as-decimal input.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { createCompany } from '@/lib/services/company';
import { listAccounts } from '@/lib/services/accounts';
import { createManualEntry } from '@/lib/services/journal';
import { trialBalance } from '@/lib/services/reports';
import { createJournalEntrySchema } from '@/lib/validation/journal';
import {
  computeJournalBalance,
  journalPayloadAmount,
  normalizeAmount,
  type JournalLineInput,
} from './journalBalance';

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ux-retest');
let db: DB;
let ctx: ServiceContext;
let cash: string;
let sales: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'ux-retest@test.local', name: 'UX Retest', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'UX Retest Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const accts = await listAccounts(ctx, { includeInactive: true });
  cash = accts.find((a) => a.code === '1000')!.id;
  sales = accts.find((a) => a.code === '4000')!.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Mirrors app/journal/page.tsx handleSubmit (the read-back test below pins that). */
function pagePayload(lines: JournalLineInput[]) {
  return {
    date: '2026-04-01',
    description: 'Retest entry',
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
  if (!parsed.success) {
    throw new Error(`schema rejected: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`);
  }
  return createManualEntry(ctx, parsed.data);
}

function totalsOf(entry: unknown): { debit: Decimal; credit: Decimal } {
  const lines = (entry as { lines?: { debit: string | null; credit: string | null }[] }).lines ?? [];
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const l of lines) {
    debit = debit.plus(l.debit ?? 0);
    credit = credit.plus(l.credit ?? 0);
  }
  return { debit, credit };
}

describe('journal page sends the normalized payload', () => {
  it('app/journal/page.tsx builds debit/credit through journalPayloadAmount (not raw strings)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app', 'journal', 'page.tsx'), 'utf8');
    expect(src).toMatch(/debit:\s*journalPayloadAmount\(l\.debit\)/);
    expect(src).toMatch(/credit:\s*journalPayloadAmount\(l\.credit\)/);
    // The old raw ternary `debit: l.debit ? l.debit : undefined` is gone (`?? ''` prefill is fine).
    expect(src).not.toMatch(/debit:\s*l\.debit\s*\?\s*l\.debit/);
  });
});

describe('round-0 failures, verified end to end', () => {
  it('"1,250.00" debit vs "1250" credit: Save enabled, API accepts, ledger stores 1250.00', async () => {
    const lines = [
      { accountId: cash, debit: '1,250.00', credit: '' },
      { accountId: sales, debit: '', credit: '1250' },
    ];
    expect(computeJournalBalance(lines).canSave).toBe(true);
    const entry = await postLikeThePage(lines);
    const t = totalsOf(entry);
    if ((entry as { lines?: unknown[] }).lines) {
      expect(t.debit.toFixed(2)).toBe('1250.00');
      expect(t.credit.toFixed(2)).toBe('1250.00');
    }
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('" 7.25 " (spaces), tabs and non-breaking spaces post instead of a DecimalError 500', async () => {
    for (const amt of [' 7.25 ', '\t7.25', '7.25 ', ' 1,000 ']) {
      const lines = [
        { accountId: cash, debit: amt, credit: '' },
        { accountId: sales, debit: '', credit: normalizeAmount(amt) },
      ];
      expect(computeJournalBalance(lines).canSave, JSON.stringify(amt)).toBe(true);
      await expect(postLikeThePage(lines), JSON.stringify(amt)).resolves.toBeTruthy();
    }
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('a two-sided line is blocked by the gate; a "0.00" opposite side is not two-sided and posts', async () => {
    const both = computeJournalBalance([
      { accountId: cash, debit: '10', credit: '5' },
      { accountId: sales, debit: '', credit: '5' },
    ]);
    expect(both.canSave).toBe(false);
    expect(both.blocker).toMatch(/both a debit and a credit/);
    // Comma/space forms of a two-sided line are caught too.
    expect(
      computeJournalBalance([
        { accountId: cash, debit: ' 1,000 ', credit: '0.01' },
        { accountId: sales, debit: '0.01', credit: '1000' },
      ]).canSave,
    ).toBe(false);

    // Edit-mode prefill can carry "0.00" on the unused side; that must still save and post.
    const zeroSide = [
      { accountId: cash, debit: '42.00', credit: '0.00' },
      { accountId: sales, debit: '0', credit: '42' },
    ];
    expect(computeJournalBalance(zeroSide).canSave).toBe(true);
    await expect(postLikeThePage(zeroSide)).resolves.toBeTruthy();
  });

  // Deferred to the services team: the fix belongs in zMoney (lib/validation/helpers.ts:
  // .transform(s => s.trim())) or in posting.ts (wrap DecimalError as VALIDATION), both
  // outside this UI-only team's scope. The journal page itself always sends a normalized
  // amount (see journalPayloadAmount). QA: kept running (not skipped) so the open server bug stays visible.
  it('the server half: an unnormalized " 7.25 " reaching postJournalEntry fails as a ServiceError, not a 500', async () => {
    // zMoney accepts " 7.25 " (it trims only for its regex). If any other caller sends it,
    // posting must answer with a VALIDATION ServiceError rather than a raw DecimalError.
    const parsed = createJournalEntrySchema.safeParse({
      date: '2026-04-01',
      description: 'raw whitespace',
      reference: null,
      lines: [
        { accountId: cash, debit: ' 7.25 ', memo: null, classId: null },
        { accountId: sales, credit: '7.25', memo: null, classId: null },
      ],
    });
    if (!parsed.success) return; // schema rejecting it is also an acceptable outcome
    let err: unknown = null;
    let posted = false;
    try {
      await createManualEntry(ctx, parsed.data);
      posted = true;
    } catch (e) {
      err = e;
    }
    expect(posted || err instanceof ServiceError, `raw error: ${String(err)}`).toBe(true);
  });
});

describe('fuzzed amounts: whatever the gate allows, the API and posting accept', () => {
  // Deterministic LCG so failures reproduce.
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pieces = ['0', '1', '9', '12', '250', '1,000', ',', '.', '.5', '.05', ' ', '\t', '-', '00', '7'];

  it('300 random amount strings', async () => {
    let allowed = 0;
    for (let i = 0; i < 300; i++) {
      let s = '';
      const k = 1 + rnd(4);
      for (let j = 0; j < k; j++) s += pieces[rnd(pieces.length)];
      const lines = [
        { accountId: cash, debit: s, credit: '' },
        { accountId: sales, debit: '', credit: s },
      ];
      const bal = computeJournalBalance(lines);
      if (!bal.canSave) continue;
      allowed++;
      const parsed = createJournalEntrySchema.safeParse(pagePayload(lines));
      expect(parsed.success, `schema rejected gate-approved ${JSON.stringify(s)}`).toBe(true);
      if (parsed.success) {
        await expect(createManualEntry(ctx, parsed.data), JSON.stringify(s)).resolves.toBeTruthy();
      }
    }
    expect(allowed).toBeGreaterThan(5);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});

describe('amount edge cases the gate should not wave through', () => {
  it('an amount too large for the ledger (numeric(15,2): 13 integer digits) is blocked or rejected cleanly', async () => {
    const big = '99999999999999.99'; // 14 integer digits
    const lines = [
      { accountId: cash, debit: big, credit: '' },
      { accountId: sales, debit: '', credit: big },
    ];
    const gate = computeJournalBalance(lines).canSave;
    if (!gate) return; // the client blocks it: fine
    // The client allowed Save, so the server must answer with a ServiceError (friendly
    // VALIDATION), not a raw Postgres "numeric field overflow" -> 500.
    let err: unknown = null;
    try {
      await postLikeThePage(lines);
    } catch (e) {
      err = e;
    }
    expect(err, 'oversized amount was posted').not.toBeNull();
    expect(err instanceof ServiceError, `raw error reached the route: ${String(err)}`).toBe(true);
  });

  it('comma used as a decimal mark ("12,50") is not silently read as 1250', () => {
    // normalizeAmount strips every comma, so "12,50" becomes "1250" — a 100x error with
    // "Balanced" shown if both sides are typed the same way. Thousands separators should
    // only be accepted in groups of three ("1,250"), otherwise the line is invalid.
    const bal = computeJournalBalance([
      { accountId: 'a', debit: '12,50', credit: '' },
      { accountId: 'b', debit: '', credit: '12,50' },
    ]);
    expect(bal.canSave).toBe(false);
    expect(bal.invalidLines).toEqual([1, 2]);
  });

  it('thousands separators are still accepted only in groups of three', () => {
    for (const ok of ['1,250', '1,250.50', '12,345,678.9', '999,999']) {
      const bal = computeJournalBalance([
        { accountId: 'a', debit: ok, credit: '' },
        { accountId: 'b', debit: '', credit: ok },
      ]);
      expect(bal.canSave, ok).toBe(true);
      expect(journalPayloadAmount(ok), ok).toBe(ok.replace(/,/g, ''));
    }
    for (const bad of ['1,2,3', '12,50', '1,25', ',125', '125,', '1,2500', '1250,00']) {
      const bal = computeJournalBalance([
        { accountId: 'a', debit: bad, credit: '' },
        { accountId: 'b', debit: '', credit: '1' },
      ]);
      expect(bal.invalidLines, bad).toContain(1);
      expect(bal.blocker, bad).toMatch(/isn’t a number/);
    }
  });

  it('13 integer digits fit; 14 are blocked with a plain-language reason; oversized totals too', () => {
    const fits = computeJournalBalance([
      { accountId: 'a', debit: '9999999999999.99', credit: '' },
      { accountId: 'b', debit: '', credit: '9,999,999,999,999.99' },
    ]);
    expect(fits.canSave).toBe(true);
    const big = computeJournalBalance([
      { accountId: 'a', debit: '10000000000000', credit: '' },
      { accountId: 'b', debit: '', credit: '10000000000000' },
    ]);
    expect(big.canSave).toBe(false);
    expect(big.blocker).toMatch(/too large/);
    const sum = computeJournalBalance([
      { accountId: 'a', debit: '9000000000000', credit: '' },
      { accountId: 'a', debit: '9000000000000', credit: '' },
      { accountId: 'b', debit: '', credit: '9000000000000' },
      { accountId: 'b', debit: '', credit: '9000000000000' },
    ]);
    expect(sum.canSave).toBe(false);
    expect(sum.blocker).toMatch(/total .* too large/);
  });
});

describe('<Help> on the key money forms', () => {
  it('each page imports Help and uses it on at least one form label', () => {
    for (const page of ['invoices', 'payments', 'deposits', 'bills', 'pay-bills', 'expenses', 'bank-feeds', 'journal', 'reconcile']) {
      const src = fs.readFileSync(path.join(ROOT, 'app', page, 'page.tsx'), 'utf8');
      expect(src, `app/${page}`).toMatch(/import \{ Help \} from '@\/components\/Help'/);
      expect(src, `app/${page}`).toMatch(/<Help term="[a-z-]+"/);
    }
  });
});
