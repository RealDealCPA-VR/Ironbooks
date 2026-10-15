/**
 * Bank feed rules that learn (team bankrules) — integration tests on a throwaway PGlite DB:
 *   - learning threshold: offer after the 2nd identical choice, not the 1st; dismiss / accept
 *   - unmatch removes a choice from history (voided entry)
 *   - rule CRUD validation, record locking, reorder, test-against-recent-lines
 *   - suggestions: rule beats history, history confidence + reason, rule actions carried
 *   - bulk accept: balanced entries, splits + class, per-line failures skipped (closed period,
 *     already reviewed, other company), high-confidence mode recomputed server-side
 *   - auto-mode rules post on their own
 *   - company scoping everywhere
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  bankAccounts,
  bankCategorizationHistory,
  bankRuleDismissals,
  bankTransactions,
  classes,
  companies,
  journalEntries,
  journalEntryLines,
  transactionRules,
  users,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { trialBalance } from './reports';
import { categorize, categorizeSuggested, unmatch } from './bankCategorize';
import {
  acceptOffer,
  createBankRule,
  deleteBankRule,
  dismissOffer,
  getBankRule,
  listBankRules,
  offerForTransaction,
  reorderBankRules,
  ruleOffers,
  testBankRule,
  updateBankRule,
} from './bankRules';
import { bulkAccept, runAutoRules, suggestForAccount } from './bankSuggest';
import { matchRule } from './rules';
import { ruleBodySchema } from '@/lib/bankRules/schemas';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-bankrules');

let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
let bankAccountId: string;
let checkingGl: string;
let fuel: string;
let meals: string;
let office: string;
let sales: string;
let classA: string;
let classB: string;
let otherAccount: string;
let otherBankAccountId: string;
let otherTxn: string;

let seq = 0;
async function feed(description: string, amount: string, date = '2025-03-10', bank = bankAccountId, company?: string) {
  seq += 1;
  const [row] = await db
    .insert(bankTransactions)
    .values({
      companyId: company ?? ctx.companyId,
      bankAccountId: bank,
      date: new Date(`${date}T12:00:00Z`),
      description,
      amount,
      fitId: `fit-${seq}`,
    })
    .returning();
  return row.id;
}

async function expectBalanced(c: ServiceContext) {
  const tb = await trialBalance(c);
  expect(tb.totalDebit).toBe(tb.totalCredit);
}

async function entryLines(entryId: string) {
  return db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
}

describe('bank rules that learn', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rules@test.local', name: 'Rules', passwordHash: 'x' }).returning();
    const [co] = await db.insert(companies).values({ name: 'Rules Co', ownerId: user.id }).returning();
    const [co2] = await db.insert(companies).values({ name: 'Other Co', ownerId: user.id }).returning();
    ctx = { db, companyId: co.id, userId: user.id };
    other = { db, companyId: co2.id, userId: user.id };

    const acct = async (companyId: string, code: string, name: string, type: string, subtype: string) =>
      (await db.insert(accounts).values({ companyId, code, name, type: type as never, subtype: subtype as never }).returning())[0].id;
    checkingGl = await acct(co.id, '1000', 'Checking', 'asset', 'checking');
    await acct(co.id, '3000', 'Owner Equity', 'equity', 'owners_equity');
    sales = await acct(co.id, '4000', 'Sales', 'revenue', 'sales');
    fuel = await acct(co.id, '6100', 'Fuel', 'expense', 'operating_expenses');
    meals = await acct(co.id, '6200', 'Meals', 'expense', 'operating_expenses');
    office = await acct(co.id, '6300', 'Office Supplies', 'expense', 'operating_expenses');
    const otherGl = await acct(co2.id, '1000', 'Other Checking', 'asset', 'checking');
    otherAccount = await acct(co2.id, '6100', 'Other Fuel', 'expense', 'operating_expenses');

    [classA] = (await db.insert(classes).values({ companyId: co.id, name: 'East' }).returning()).map((r) => r.id);
    [classB] = (await db.insert(classes).values({ companyId: co.id, name: 'West' }).returning()).map((r) => r.id);

    bankAccountId = (await db.insert(bankAccounts).values({ companyId: co.id, accountId: checkingGl, bankName: 'Test Bank', accountNumber: '1111' }).returning())[0].id;
    otherBankAccountId = (await db.insert(bankAccounts).values({ companyId: co2.id, accountId: otherGl, bankName: 'Other Bank', accountNumber: '2222' }).returning())[0].id;
    otherTxn = await feed('SHELL OIL 1 OTHERTOWN', '-10.00', '2025-03-01', otherBankAccountId, co2.id);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Learning
  // -------------------------------------------------------------------------

  describe('learning threshold', () => {
    it('records each categorization under the normalized pattern', async () => {
      const t1 = await feed('PURCHASE AUTHORIZED ON 03/01 SHELL OIL 57444 HOUSTON TX CARD 1234', '-40.00', '2025-03-01');
      await categorize(ctx, { bankTransactionId: t1, accountId: fuel });
      const [h] = await db.select().from(bankCategorizationHistory).where(eq(bankCategorizationHistory.bankTransactionId, t1));
      expect(h.pattern).toBe('SHELL OIL');
      expect(h.direction).toBe('out');
      expect(h.accountId).toBe(fuel);
      expect(h.source).toBe('user');
      // One choice is not enough to offer a rule.
      expect(await offerForTransaction(ctx, t1)).toBeNull();
      expect(await ruleOffers(ctx)).toEqual([]);
    });

    it('offers "Always categorize SHELL OIL as Fuel?" after the second identical choice', async () => {
      const t2 = await feed('SHELL OIL 12001 AUSTIN TX 03/05 CARD 9876', '-35.50', '2025-03-05');
      await categorize(ctx, { bankTransactionId: t2, accountId: fuel, payee: 'Shell' });
      const offer = await offerForTransaction(ctx, t2);
      expect(offer).not.toBeNull();
      expect(offer!.question).toBe('Always categorize SHELL OIL as Fuel?');
      expect(offer!.count).toBe(2);
      expect(offer!.accountId).toBe(fuel);
      expect(offer!.direction).toBe('out');
      // Payees differed (none, then "Shell") → the rule does not force one.
      expect(offer!.payee).toBeNull();
    });

    it('different accounts for the same pattern do not reach the threshold', async () => {
      const a = await feed('CHEVRON 0001', '-20.00', '2025-03-02');
      const b = await feed('CHEVRON 0002', '-25.00', '2025-03-03');
      await categorize(ctx, { bankTransactionId: a, accountId: fuel });
      await categorize(ctx, { bankTransactionId: b, accountId: meals });
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'CHEVRON')).toBe(false);
    });

    it('class is part of the choice: same account but different classes do not count together', async () => {
      const a = await feed('UBER TRIP 111', '-12.00', '2025-03-02');
      const b = await feed('UBER TRIP 222', '-13.00', '2025-03-03');
      await categorize(ctx, { bankTransactionId: a, accountId: meals, classId: classA });
      await categorize(ctx, { bankTransactionId: b, accountId: meals, classId: classB });
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'UBER TRIP')).toBe(false);
      const c = await feed('UBER TRIP 333', '-14.00', '2025-03-04');
      await categorize(ctx, { bankTransactionId: c, accountId: meals, classId: classA });
      const offer = (await ruleOffers(ctx)).find((o) => o.pattern === 'UBER TRIP')!;
      expect(offer.classId).toBe(classA);
      expect(offer.question).toBe('Always categorize UBER TRIP as Meals (East)?');
    });

    it('Unmatch takes the choice back out of the history', async () => {
      const a = await feed('STAPLES 0042', '-50.00', '2025-03-02');
      const b = await feed('STAPLES 0043', '-60.00', '2025-03-03');
      await categorize(ctx, { bankTransactionId: a, accountId: office });
      await categorize(ctx, { bankTransactionId: b, accountId: office });
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'STAPLES')).toBe(true);
      await unmatch(ctx, b);
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'STAPLES')).toBe(false);
    });

    it('"No thanks" hides the offer for good', async () => {
      const offer = (await ruleOffers(ctx)).find((o) => o.pattern === 'UBER TRIP')!;
      await dismissOffer(ctx, { pattern: offer.pattern, accountId: offer.accountId, direction: offer.direction });
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'UBER TRIP')).toBe(false);
      // Idempotent.
      await dismissOffer(ctx, { pattern: offer.pattern, accountId: offer.accountId, direction: offer.direction });
    });

    it('accepting creates a learned rule, after which the offer disappears and the rule matches', async () => {
      const rule = await acceptOffer(ctx, { pattern: 'SHELL OIL', accountId: fuel, direction: 'out' });
      expect(rule.learned).toBe(true);
      expect(rule.mode).toBe('suggest');
      expect(rule.setAccountId).toBe(fuel);
      expect(rule.direction).toBe('out');
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'SHELL OIL')).toBe(false);
      const hit = await matchRule(ctx, { description: 'SHELL OIL 99999 DALLAS TX', amount: '-30.00', bankAccountId });
      expect(hit?.setAccountId).toBe(fuel);
      // Money-in lines are not caught by a money-out rule.
      expect(await matchRule(ctx, { description: 'SHELL OIL REFUND', amount: '30.00', bankAccountId })).toBeNull();
      await expect(acceptOffer(ctx, { pattern: 'SHELL OIL', accountId: fuel, direction: 'out' })).rejects.toThrow(/no longer available/);
    });

    it('offers are per company', async () => {
      expect(await ruleOffers(other)).toEqual([]);
      await expect(dismissOffer(other, { pattern: 'STAPLES', accountId: office, direction: 'out' })).rejects.toThrow(/does not exist/);
    });
  });

  // -------------------------------------------------------------------------
  // Rules management
  // -------------------------------------------------------------------------

  describe('rules management', () => {
    it('validates conditions and actions', async () => {
      await expect(createBankRule(ctx, { name: '', matchValue: 'x', setAccountId: fuel })).rejects.toThrow(/name/);
      await expect(createBankRule(ctx, { name: 'No condition', setAccountId: fuel })).rejects.toThrow(/at least one condition/);
      await expect(createBankRule(ctx, { name: 'No action', matchValue: 'x' })).rejects.toThrow(/Choose the account/);
      await expect(
        createBankRule(ctx, { name: 'Range', matchValue: 'x', amountMin: '50', amountMax: '10', setAccountId: fuel }),
      ).rejects.toThrow(/bigger/);
      await expect(
        createBankRule(ctx, {
          name: 'Bad split',
          matchValue: 'x',
          splits: [
            { accountId: fuel, percent: '60' },
            { accountId: meals, percent: '30' },
          ],
        }),
      ).rejects.toThrow(/add up to 100/);
      await expect(createBankRule(ctx, { name: 'Star', matchOperator: 'pattern', matchValue: '**', setAccountId: fuel })).rejects.toThrow(/pattern/);
    });

    it('company scoping: another company\'s account / class / bank account cannot be used', async () => {
      await expect(createBankRule(ctx, { name: 'X', matchValue: 'x', setAccountId: otherAccount })).rejects.toThrow(/does not exist in this company/);
      await expect(createBankRule(ctx, { name: 'X', matchValue: 'x', setAccountId: fuel, bankAccountId: otherBankAccountId })).rejects.toThrow(/does not exist in this company/);
      await expect(createBankRule(other, { name: 'X', matchValue: 'x', setAccountId: otherAccount, setClassId: classA })).rejects.toThrow(/does not exist in this company/);
      const mine = await listBankRules(ctx);
      expect(mine.length).toBeGreaterThan(0);
      expect(await listBankRules(other)).toEqual([]);
      await expect(getBankRule(other, mine[0].id)).rejects.toThrow(/not found/);
      await expect(updateBankRule(other, mine[0].id, { name: 'hijack' })).rejects.toThrow(/not found/);
      await expect(deleteBankRule(other, mine[0].id)).rejects.toThrow(/not found/);
      await expect(reorderBankRules(other, [mine[0].id])).rejects.toThrow(/does not exist/);
    });

    it('new rules go to the top; reorder rewrites the order; enable/disable; delete', async () => {
      const a = await createBankRule(ctx, { name: 'Coffee', matchValue: 'starbucks', setAccountId: meals });
      const b = await createBankRule(ctx, { name: 'Big coffee', matchValue: 'starbucks', amountMin: '100', setAccountId: office });
      let list = await listBankRules(ctx);
      expect(list[0].id).toBe(b.id);
      expect(list[1].id).toBe(a.id);

      list = await reorderBankRules(ctx, [a.id, ...list.filter((r) => r.id !== a.id).map((r) => r.id)]);
      expect(list[0].id).toBe(a.id);
      // "Coffee" is now checked first, so it wins even for a big amount.
      expect((await matchRule(ctx, { description: 'STARBUCKS 123', amount: '-150.00', bankAccountId }))?.setAccountId).toBe(meals);

      await updateBankRule(ctx, a.id, { enabled: false });
      expect((await matchRule(ctx, { description: 'STARBUCKS 123', amount: '-150.00', bankAccountId }))?.setAccountId).toBe(office);
      expect((await listBankRules(ctx)).find((r) => r.id === a.id)?.enabled).toBe(false);

      await deleteBankRule(ctx, b.id);
      expect((await listBankRules(ctx)).some((r) => r.id === b.id)).toBe(false);
      expect(await matchRule(ctx, { description: 'STARBUCKS 123', amount: '-150.00', bankAccountId })).toBeNull();
      await expect(reorderBankRules(ctx, [a.id])).rejects.toThrow(/every rule/);
    });

    it('record locking: a save based on an old version is refused', async () => {
      const r = await createBankRule(ctx, { name: 'Lock me', matchValue: 'lockme', setAccountId: fuel });
      const loaded = await getBankRule(ctx, r.id);
      const first = await updateBankRule(ctx, r.id, { name: 'Lock me 2' }, loaded.updatedAt.toISOString());
      expect(first.name).toBe('Lock me 2');
      await expect(updateBankRule(ctx, r.id, { name: 'stale' }, loaded.updatedAt.toISOString())).rejects.toMatchObject({ code: 'CONFLICT' });
      const fresh = await updateBankRule(ctx, r.id, { name: 'Lock me 3' }, first.updatedAt.toISOString());
      expect(fresh.name).toBe('Lock me 3');
      await deleteBankRule(ctx, r.id);
    });

    it('test against recent transactions lists matches and shadowing rules, without changing anything', async () => {
      await feed('HOME DEPOT 4521', '-80.00', new Date().toISOString().slice(0, 10));
      await feed('HOME DEPOT 4522 ATLANTA', '-120.00', new Date().toISOString().slice(0, 10));
      const res = await testBankRule(ctx, { name: '', matchOperator: 'pattern', matchValue: 'home depot*', amountMin: '100' });
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0].amount).toBe('-120.00');
      expect(res.hits[0].shadowedBy).toBeNull();

      const shell = await testBankRule(ctx, { name: 'Shell draft', matchValue: 'shell', priority: -100 }, { days: 3650 });
      expect(shell.hits.length).toBeGreaterThan(0);
      // The learned "SHELL OIL → Fuel" rule is checked before a priority −100 draft.
      expect(shell.hits.some((h) => h.shadowedBy?.name === 'SHELL OIL → Fuel')).toBe(true);
      // Other companies' lines never show up.
      expect(shell.hits.some((h) => h.bankTransactionId === otherTxn)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Suggestions + bulk accept
  // -------------------------------------------------------------------------

  describe('suggestions and bulk accept', () => {
    let shellLine: string;
    let staplesLine: string;
    let unknownLine: string;

    it('rule beats history; history gives confidence + "you chose" reason', async () => {
      shellLine = await feed('SHELL OIL 31313 PLANO TX', '-44.00', '2025-03-20');
      staplesLine = await feed('STAPLES 0099', '-75.25', '2025-03-20');
      unknownLine = await feed('MYSTERY VENDOR', '-9.99', '2025-03-20');
      const s = await suggestForAccount(ctx, bankAccountId, { bankTransactionIds: [shellLine, staplesLine, unknownLine], localModel: false });
      const byId = new Map(s.map((x) => [x.bankTransactionId, x]));

      const shell = byId.get(shellLine)!;
      expect(shell.source).toBe('rule');
      expect(shell.accountId).toBe(fuel);
      expect(shell.confidence).toBeGreaterThanOrEqual(98);
      expect(shell.reason).toContain('Matched rule "SHELL OIL → Fuel"');
      expect(shell.reason).toContain('You chose Fuel 2 times');

      const staples = byId.get(staplesLine)!;
      expect(staples.source).toBe('history');
      expect(staples.accountId).toBe(office);
      expect(staples.reason).toMatch(/You chose Office Supplies 1 time/);
      expect(staples.confidence).toBeGreaterThan(0);
      expect(staples.confidence).toBeLessThan(90);

      const unknown = byId.get(unknownLine)!;
      expect(unknown.accountId).toBeNull();
      expect(unknown.confidence).toBe(0);
    });

    it('carries rule actions (class, payee, memo) into the suggestion', async () => {
      const r = await createBankRule(ctx, {
        name: 'Rent',
        matchValue: 'landlord llc',
        direction: 'out',
        setAccountId: office,
        setClassId: classB,
        setPayee: 'Landlord LLC',
        setMemo: 'Monthly rent',
      });
      const rent = await feed('ACH DEBIT LANDLORD LLC 0003', '-1000.00', '2025-03-21');
      const [s] = await suggestForAccount(ctx, bankAccountId, { bankTransactionIds: [rent], localModel: false });
      expect(s.ruleId).toBe(r.id);
      expect(s.classId).toBe(classB);
      expect(s.payee).toBe('Landlord LLC');
      expect(s.memo).toBe('Monthly rent');
    });

    it('bulk accept (selected) posts balanced entries, applies splits + class, and skips failures', async () => {
      await createBankRule(ctx, {
        name: 'Phone split',
        matchValue: 'verizon',
        splits: [
          { accountId: office, classId: classA, percent: '60' },
          { accountId: meals, classId: classB, percent: '40' },
        ],
      });
      const phone = await feed('VERIZON WIRELESS 8812', '-100.01', '2025-03-22');
      // A line in a closed period (closing date) must fail without blocking the others.
      await db.update(companies).set({ settings: { closingDate: '2025-01-31' } }).where(eq(companies.id, ctx.companyId));
      const closed = await feed('SHELL OIL 777 OLDTOWN', '-15.00', '2025-01-15');
      const zero = await feed('ZERO LINE', '0.00', '2025-03-22');

      const res = await bulkAccept(ctx, {
        items: [
          { bankTransactionId: shellLine }, // take the suggestion (rule)
          { bankTransactionId: phone }, // rule split
          { bankTransactionId: staplesLine, accountId: office, classId: classA }, // explicit choice
          { bankTransactionId: closed },
          { bankTransactionId: zero, accountId: office },
          { bankTransactionId: otherTxn, accountId: fuel }, // another company's line
        ],
      }, { localModel: false });
      expect(res.accepted.map((a) => a.bankTransactionId).sort()).toEqual([shellLine, phone, staplesLine].sort());
      const failed = new Map(res.failed.map((f) => [f.bankTransactionId, f]));
      expect(failed.get(closed)?.code).toBe('PERIOD_CLOSED');
      expect(failed.get(zero)?.code).toBe('VALIDATION');
      expect(failed.get(otherTxn)?.code).toBe('NOT_FOUND');
      await expectBalanced(ctx);

      // Split: 60.01 / 40.00 (largest-remainder), each with its class; bank credited the total.
      const phoneEntry = res.accepted.find((a) => a.bankTransactionId === phone)!.entryId;
      const lines = await entryLines(phoneEntry);
      const officeLine = lines.find((l) => l.accountId === office)!;
      const mealsLine = lines.find((l) => l.accountId === meals)!;
      const bankLine = lines.find((l) => l.accountId === checkingGl)!;
      expect(officeLine.debit).toBe('60.01');
      expect(officeLine.classId).toBe(classA);
      expect(mealsLine.debit).toBe('40.00');
      expect(mealsLine.classId).toBe(classB);
      expect(bankLine.credit).toBe('100.01');

      const staplesEntry = res.accepted.find((a) => a.bankTransactionId === staplesLine)!.entryId;
      expect((await entryLines(staplesEntry)).find((l) => l.accountId === office)?.classId).toBe(classA);

      // Rule usage is counted for the rule-based acceptances; nothing posted for failures.
      const shellRule = (await listBankRules(ctx)).find((r) => r.name === 'SHELL OIL → Fuel')!;
      expect(shellRule.appliedCount).toBe(1);
      const [closedRow] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, closed));
      expect(closedRow.matched).toBe(false);
      const [otherRow] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, otherTxn));
      expect(otherRow.matched).toBe(false);

      // Accepting the same line again fails per line (already reviewed), not as a whole.
      const again = await bulkAccept(ctx, { items: [{ bankTransactionId: shellLine, accountId: fuel }] }, { localModel: false });
      expect(again.accepted).toHaveLength(0);
      expect(again.failed[0].code).toBe('CONFLICT');
      await db.update(companies).set({ settings: {} }).where(eq(companies.id, ctx.companyId));
    });

    it('accept all high-confidence takes only lines ≥ 90% (recomputed on the server)', async () => {
      const sure = await feed('SHELL OIL 4040 WACO TX', '-22.00', '2025-03-25');
      const unsure = await feed('STAPLES 0100', '-12.00', '2025-03-25');
      const before = await suggestForAccount(ctx, bankAccountId, { bankTransactionIds: [sure, unsure], localModel: false });
      expect(before.find((s) => s.bankTransactionId === sure)!.confidence).toBeGreaterThanOrEqual(90);
      expect(before.find((s) => s.bankTransactionId === unsure)!.confidence).toBeLessThan(90);

      const res = await bulkAccept(ctx, { bankAccountId, allHighConfidence: true }, { localModel: false });
      const accepted = res.accepted.map((a) => a.bankTransactionId);
      expect(accepted).toContain(sure);
      expect(accepted).not.toContain(unsure);
      expect(res.accepted.every((a) => (a.confidence ?? 0) >= 90)).toBe(true);
      await expectBalanced(ctx);

      // Another company cannot bulk-accept this company's bank account.
      await expect(bulkAccept(other, { bankAccountId, allHighConfidence: true })).rejects.toThrow(/not found/);
      await expect(suggestForAccount(other, bankAccountId)).rejects.toThrow(/not found/);
    });

    it('bulk-accepted (history) choices teach the engine; rule-based ones do not double count', async () => {
      const a = await feed('OFFICE DEPOT 1', '-5.00', '2025-03-26');
      const b = await feed('OFFICE DEPOT 2', '-6.00', '2025-03-26');
      await bulkAccept(
        ctx,
        { items: [{ bankTransactionId: a, accountId: office }, { bankTransactionId: b, accountId: office }] },
        { localModel: false },
      );
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'OFFICE DEPOT' && o.accountId === office)).toBe(true);
    });
  });

  describe('review fixes (round 2)', () => {
    it('a rule switched off (or deleted) after import never drives a suggestion or "accept all high-confidence"', async () => {
      // Own bank account so other suites' leftover lines cannot be swept up.
      const ba = (await db.insert(bankAccounts).values({ companyId: ctx.companyId, accountId: checkingGl, bankName: 'Probe Bank', accountNumber: '3333' }).returning())[0].id;
      const rule = await createBankRule(ctx, { name: 'Burger → Meals', matchValue: 'zorbo burger', setAccountId: meals });
      const line = await feed('ZORBO BURGER 5521', '-18.00', '2025-03-28', ba);
      // What the import-time rule pass leaves behind.
      await db.update(bankTransactions).set({ suggestedAccountId: meals }).where(eq(bankTransactions.id, line));
      const live = await suggestForAccount(ctx, ba, { localModel: false });
      expect(live[0].source).toBe('rule');
      expect(live[0].confidence).toBeGreaterThanOrEqual(90);

      await updateBankRule(ctx, rule.id, { enabled: false });
      const [off] = await suggestForAccount(ctx, ba, { localModel: false });
      expect(off.source).not.toBe('rule');
      expect(off.ruleId).toBeNull();
      expect(off.confidence).toBeLessThan(90);
      const res = await bulkAccept(ctx, { bankAccountId: ba, allHighConfidence: true }, { localModel: false });
      expect(res.accepted).toHaveLength(0);

      await deleteBankRule(ctx, rule.id);
      const [gone] = await suggestForAccount(ctx, ba, { localModel: false });
      expect(gone.source).not.toBe('rule');
      expect(gone.confidence).toBeLessThan(90);
      expect((await bulkAccept(ctx, { bankAccountId: ba, allHighConfidence: true }, { localModel: false })).accepted).toHaveLength(0);
      const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, line));
      expect(row.matched).toBe(false);
    });

    it('a kept split suggestion posts as a split, with the row class as default for unclassed split lines', async () => {
      await createBankRule(ctx, {
        name: 'Internet split',
        matchValue: 'comcast',
        splits: [
          { accountId: office, percent: '50' },
          { accountId: fuel, classId: classB, percent: '50' },
        ],
      });
      const line = await feed('COMCAST CABLE 0912', '-80.00', '2025-03-28');
      const [sg] = await suggestForAccount(ctx, bankAccountId, { bankTransactionIds: [line], localModel: false });
      expect(sg.splits).toHaveLength(2);
      // What the review screen now sends for "Accept selected" when the user kept the suggestion
      // and the row's Class picker holds a class.
      const res = await bulkAccept(
        ctx,
        { items: [{ bankTransactionId: line, accountId: sg.accountId!, classId: classA, splits: sg.splits }] },
        { localModel: false },
      );
      expect(res.failed).toEqual([]);
      const lines = await entryLines(res.accepted[0].entryId);
      expect(lines.find((l) => l.accountId === office)?.debit).toBe('40.00');
      expect(lines.find((l) => l.accountId === office)?.classId).toBe(classA);
      expect(lines.find((l) => l.accountId === fuel)?.debit).toBe('40.00');
      expect(lines.find((l) => l.accountId === fuel)?.classId).toBe(classB);
      expect((await listBankRules(ctx)).find((r) => r.name === 'Internet split')!.appliedCount).toBe(1);
      await expectBalanced(ctx);
    });

    it('rule priority must be a sane whole number (API schema and service)', async () => {
      const base = { name: 'P', matchValue: 'x', setAccountId: fuel };
      const bad = ruleBodySchema.safeParse({ ...base, priority: 1e12 });
      expect(bad.success).toBe(false);
      expect(bad.error!.issues[0].path).toEqual(['priority']);
      expect(ruleBodySchema.safeParse({ ...base, priority: 1_000_000 }).success).toBe(true);
      await expect(createBankRule(ctx, { ...base, priority: 1e12 })).rejects.toThrow(/Priority must be/);
      const r = await createBankRule(ctx, { ...base, name: 'Priority probe', matchValue: 'qqqprobe' });
      await expect(updateBankRule(ctx, r.id, { priority: -5_000_000 })).rejects.toThrow(/Priority must be/);
      await deleteBankRule(ctx, r.id);
    });
  });

  describe('review fixes (round 3)', () => {
    const newBank = async (n: string) =>
      (await db.insert(bankAccounts).values({ companyId: ctx.companyId, accountId: checkingGl, bankName: `Bank ${n}`, accountNumber: n }).returning())[0].id;
    const row = async (id: string) => (await db.select().from(bankTransactions).where(eq(bankTransactions.id, id)))[0];

    it('"Add all suggested" only posts lines a live rule still gives, as source "rule" (never learning)', async () => {
      const ba = await newBank('4401');
      const live = await createBankRule(ctx, { name: 'Gizmo → Office', matchValue: 'gizmo mart', setAccountId: office, setClassId: classA });
      const off = await createBankRule(ctx, { name: 'Widget → Fuel', matchValue: 'widget hub', setAccountId: fuel });
      const g = await feed('GIZMO MART 0001', '-30.00', '2025-04-02', ba);
      const w = await feed('WIDGET HUB 0001', '-31.00', '2025-04-02', ba);
      const s = await feed('STALE THING 0001', '-32.00', '2025-04-02', ba);
      // What the import-time rule pass left behind (the "stale thing" rule is long gone).
      await db.update(bankTransactions).set({ suggestedAccountId: office }).where(eq(bankTransactions.id, g));
      await db.update(bankTransactions).set({ suggestedAccountId: fuel }).where(eq(bankTransactions.id, w));
      await db.update(bankTransactions).set({ suggestedAccountId: meals }).where(eq(bankTransactions.id, s));
      // Switched off behind the service's back (e.g. the legacy rules API): no refresh ran.
      await db.update(transactionRules).set({ enabled: false }).where(eq(transactionRules.id, off.id));

      expect(await categorizeSuggested(ctx, ba)).toBe(1);
      const gRow = await row(g);
      expect(gRow.matched).toBe(true);
      const [h] = await db.select().from(bankCategorizationHistory).where(eq(bankCategorizationHistory.bankTransactionId, g));
      expect(h.source).toBe('rule');
      expect(h.ruleId).toBe(live.id);
      expect((await entryLines(gRow.matchedEntryId!)).find((l) => l.accountId === office)?.classId).toBe(classA);
      expect((await getBankRule(ctx, live.id)).appliedCount).toBe(1);
      // The disabled rule's line and the orphan line are skipped and their stale suggestion cleared.
      for (const id of [w, s]) {
        const r = await row(id);
        expect(r.matched).toBe(false);
        expect(r.suggestedAccountId).toBeNull();
      }
      await expectBalanced(ctx);
      await expect(categorizeSuggested(other, ba)).rejects.toThrow(/not found/);
    });

    it('editing, switching off or deleting a rule re-checks the import-time suggestion of unreviewed lines', async () => {
      const ba = await newBank('4402');
      const rule = await createBankRule(ctx, { name: 'Sprocket → Meals', matchValue: 'sprocket co', setAccountId: meals });
      const p = await feed('SPROCKET CO 0001', '-12.00', '2025-04-03', ba);
      await db.update(bankTransactions).set({ suggestedAccountId: meals }).where(eq(bankTransactions.id, p));
      await db.update(bankTransactions).set({ suggestedAccountId: otherAccount }).where(eq(bankTransactions.id, otherTxn));

      await updateBankRule(ctx, rule.id, { setAccountId: office });
      expect((await row(p)).suggestedAccountId).toBe(office);
      await updateBankRule(ctx, rule.id, { enabled: false });
      expect((await row(p)).suggestedAccountId).toBeNull();

      await updateBankRule(ctx, rule.id, { enabled: true });
      await db.update(bankTransactions).set({ suggestedAccountId: office }).where(eq(bankTransactions.id, p));
      await deleteBankRule(ctx, rule.id);
      expect((await row(p)).suggestedAccountId).toBeNull();
      // Another company's lines are never touched.
      expect((await row(otherTxn)).suggestedAccountId).toBe(otherAccount);
      await db.update(bankTransactions).set({ suggestedAccountId: null }).where(eq(bankTransactions.id, otherTxn));
    });

    it('a rule limited to one bank account covers that account\'s choices: no duplicate general offer', async () => {
      const baA = await newBank('4403');
      const baB = await newBank('4404');
      await createBankRule(ctx, { name: 'Acme fuel (A only)', matchValue: 'acme fuel', bankAccountId: baA, direction: 'out', setAccountId: fuel });
      for (const n of ['0001', '0002']) {
        await categorize(ctx, { bankTransactionId: await feed(`ACME FUEL ${n}`, '-20.00', '2025-04-04', baA), accountId: fuel });
      }
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'ACME FUEL')).toBe(false);
      expect(await ruleOffers(ctx, { pattern: 'ACME FUEL' })).toEqual([]);
      // Choices on another bank account are not covered by that rule and do count.
      await categorize(ctx, { bankTransactionId: await feed('ACME FUEL 0003', '-21.00', '2025-04-04', baB), accountId: fuel });
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'ACME FUEL')).toBe(false);
      await categorize(ctx, { bankTransactionId: await feed('ACME FUEL 0004', '-22.00', '2025-04-04', baB), accountId: fuel });
      const offer = (await ruleOffers(ctx)).find((o) => o.pattern === 'ACME FUEL')!;
      expect(offer.count).toBe(2);
    });

    it('"No thanks" is per direction: dismissing money out leaves a money-in offer alone', async () => {
      const ba = await newBank('4405');
      for (const n of ['0001', '0002']) {
        await categorize(ctx, { bankTransactionId: await feed(`REFUNDO SHOP ${n}`, '-15.00', '2025-04-05', ba), accountId: office });
      }
      const out = (await ruleOffers(ctx)).find((o) => o.pattern === 'REFUNDO SHOP')!;
      expect(out.direction).toBe('out');
      await dismissOffer(ctx, { pattern: out.pattern, accountId: out.accountId, direction: 'out' });
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'REFUNDO SHOP')).toBe(false);

      for (const n of ['0003', '0004']) {
        await categorize(ctx, { bankTransactionId: await feed(`REFUNDO SHOP ${n}`, '15.00', '2025-04-05', ba), accountId: office });
      }
      const offers = (await ruleOffers(ctx)).filter((o) => o.pattern === 'REFUNDO SHOP');
      expect(offers.map((o) => o.direction)).toEqual(['in']);
      await dismissOffer(ctx, { pattern: 'REFUNDO SHOP', accountId: office, direction: 'in' });
      expect((await ruleOffers(ctx)).some((o) => o.pattern === 'REFUNDO SHOP')).toBe(false);

      const rows = await db
        .select()
        .from(bankRuleDismissals)
        .where(and(eq(bankRuleDismissals.companyId, ctx.companyId), eq(bankRuleDismissals.pattern, 'REFUNDO SHOP')));
      expect(rows.map((r) => r.direction).sort()).toEqual(['in', 'out']);
      await expect(
        dismissOffer(ctx, { pattern: 'REFUNDO SHOP', accountId: office, direction: 'sideways' as never }),
      ).rejects.toThrow(/Direction/);
    });
  });

  describe('auto-apply rules', () => {
    it('posts lines whose first matching rule is in auto mode, through categorize', async () => {
      const rule = await createBankRule(ctx, {
        name: 'Stripe payouts',
        matchValue: 'stripe',
        direction: 'in',
        mode: 'auto',
        setAccountId: sales,
        setPayee: 'Stripe',
      });
      const payout = await feed('STRIPE TRANSFER ST-XYZ12', '250.00', '2025-03-27');
      const refund = await feed('STRIPE REFUND', '-20.00', '2025-03-27'); // money out → not this rule
      const res = await runAutoRules(ctx, bankAccountId);
      expect(res.applied.map((a) => a.bankTransactionId)).toEqual([payout]);
      const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, payout));
      expect(row.matched).toBe(true);
      expect(row.payee).toBe('Stripe');
      const [refundRow] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, refund));
      expect(refundRow.matched).toBe(false);
      const lines = await entryLines(res.applied[0].entryId);
      expect(lines.find((l) => l.accountId === sales)?.credit).toBe('250.00');
      expect(lines.find((l) => l.accountId === checkingGl)?.debit).toBe('250.00');
      await expectBalanced(ctx);
      const [h] = await db
        .select()
        .from(bankCategorizationHistory)
        .where(and(eq(bankCategorizationHistory.bankTransactionId, payout), eq(bankCategorizationHistory.companyId, ctx.companyId)));
      expect(h.source).toBe('rule_auto');
      expect(h.ruleId).toBe(rule.id);
      expect((await getBankRule(ctx, rule.id)).appliedCount).toBe(1);
      // Running again is a no-op.
      expect((await runAutoRules(ctx, bankAccountId)).applied).toHaveLength(0);
      await expect(runAutoRules(other, bankAccountId)).rejects.toThrow(/not found/);
    });
  });

  it('every posted entry from this suite is balanced and belongs to the company', async () => {
    const entries = await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
    expect(entries.length).toBeGreaterThan(5);
    await expectBalanced(ctx);
    const rows = await db.select().from(transactionRules).where(eq(transactionRules.companyId, other.companyId));
    expect(rows).toEqual([]);
  });

  it('merging accounts moves rule splits and learned history to the surviving account', async () => {
    const { mergeAccounts } = await import('./merge');
    const before = await db
      .select()
      .from(bankCategorizationHistory)
      .where(and(eq(bankCategorizationHistory.companyId, ctx.companyId), eq(bankCategorizationHistory.accountId, meals)));
    expect(before.length).toBeGreaterThan(0);
    // The same pattern dismissed for both accounts must not break the merge (unique index).
    await dismissOffer(ctx, { pattern: 'DUP PATTERN', accountId: meals, direction: 'out' });
    await dismissOffer(ctx, { pattern: 'DUP PATTERN', accountId: office, direction: 'out' });
    // Same pattern, other direction, only on the merged-away account: survives as its own row.
    await dismissOffer(ctx, { pattern: 'DUP PATTERN', accountId: meals, direction: 'in' });
    await dismissOffer(ctx, { pattern: 'ONLY MEALS', accountId: meals, direction: 'out' });
    await mergeAccounts(ctx, { fromId: meals, toId: office });
    const dismissals = await db.select().from(bankRuleDismissals).where(eq(bankRuleDismissals.companyId, ctx.companyId));
    expect(dismissals.some((d) => d.accountId === meals)).toBe(false);
    expect(
      dismissals.filter((d) => d.pattern === 'DUP PATTERN').map((d) => `${d.direction}:${d.accountId}`).sort(),
    ).toEqual([`in:${office}`, `out:${office}`]);
    expect(dismissals.filter((d) => d.pattern === 'ONLY MEALS').map((d) => d.accountId)).toEqual([office]);
    const after = await db
      .select()
      .from(bankCategorizationHistory)
      .where(and(eq(bankCategorizationHistory.companyId, ctx.companyId), eq(bankCategorizationHistory.accountId, meals)));
    expect(after).toHaveLength(0);
    const split = (await listBankRules(ctx)).find((r) => r.name === 'Phone split')!;
    expect(split.splits!.map((s) => s.accountId)).toEqual([office, office]);
  });

  it('ServiceError type is used for failures', async () => {
    await expect(getBankRule(ctx, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(ServiceError);
  });
});
