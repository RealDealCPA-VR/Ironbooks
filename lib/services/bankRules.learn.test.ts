/**
 * Proactive rules (office feedback): categorizing a bank line by hand saves a suggest-only rule
 * for its payee right away (bankRules.learnRuleFromChoice), so the next statement comes in
 * pre-filled — instead of waiting for the same choice twice and an "Always categorize…?" click.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, bankTransactions, companies, transactionRules, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { categorize } from './bankCategorize';
import { createBankRule, dismissOffer, getBankRule, learnRuleFromChoice } from './bankRules';
import { bulkAccept, suggestForAccount } from './bankSuggest';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-bankrules-learn');

let db: DB;
let ctx: ServiceContext;
let bankAccountId: string;
let fuel: string;
let meals: string;
let office: string;
let sales: string;

let seq = 0;
async function feed(description: string, amount: string, date = '2025-04-10') {
  seq += 1;
  const [row] = await db
    .insert(bankTransactions)
    .values({ companyId: ctx.companyId, bankAccountId, date: new Date(`${date}T12:00:00Z`), description, amount, fitId: `learn-${seq}` })
    .returning();
  return row.id;
}

async function rulesFor(pattern: string) {
  const all = await db.select().from(transactionRules).where(eq(transactionRules.companyId, ctx.companyId));
  return all.filter((r) => r.matchValue === pattern);
}

describe('proactive rules from bank review choices', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'learn@test.local', name: 'Learn', passwordHash: 'x' }).returning();
    const [co] = await db.insert(companies).values({ name: 'Learn Co', ownerId: user.id }).returning();
    ctx = { db, companyId: co.id, userId: user.id };
    const acct = async (code: string, name: string, type: string, subtype: string) =>
      (await db.insert(accounts).values({ companyId: co.id, code, name, type: type as never, subtype: subtype as never }).returning())[0].id;
    const checking = await acct('1000', 'Checking', 'asset', 'checking');
    sales = await acct('4000', 'Sales', 'revenue', 'sales');
    fuel = await acct('6100', 'Fuel', 'expense', 'operating_expenses');
    meals = await acct('6200', 'Meals', 'expense', 'operating_expenses');
    office = await acct('6300', 'Office Supplies', 'expense', 'operating_expenses');
    bankAccountId = (await db.insert(bankAccounts).values({ companyId: co.id, accountId: checking, bankName: 'Bank', accountNumber: '9' }).returning())[0].id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('the first choice saves a suggest-only rule, and the next statement line is pre-filled by it', async () => {
    const t1 = await feed('PURCHASE AUTHORIZED ON 04/01 SHELL OIL 57444 HOUSTON TX CARD 1234', '-40.00');
    await categorize(ctx, { bankTransactionId: t1, accountId: fuel, payee: 'Shell' });
    const learned = await learnRuleFromChoice(ctx, t1);
    expect(learned).toMatchObject({ action: 'created', pattern: 'SHELL OIL', accountName: 'Fuel' });
    const rule = await getBankRule(ctx, learned!.ruleId);
    expect(rule).toMatchObject({ mode: 'suggest', learned: true, direction: 'out', setAccountId: fuel, setPayee: 'Shell' });

    // Next month's statement: the same payee comes in suggested by the rule (not posted).
    const t2 = await feed('PURCHASE AUTHORIZED ON 05/02 SHELL OIL 99881 DALLAS TX CARD 1234', '-35.10', '2025-05-02');
    const s = (await suggestForAccount(ctx, bankAccountId)).find((x) => x.bankTransactionId === t2);
    expect(s).toMatchObject({ source: 'rule', accountId: fuel });
    const [still] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t2));
    expect(still.matched).toBe(false);

    // Same choice again: nothing to change.
    await categorize(ctx, { bankTransactionId: t2, accountId: fuel });
    expect(await learnRuleFromChoice(ctx, t2)).toBeNull();
    expect(await rulesFor('SHELL OIL')).toHaveLength(1);
  });

  it('a different choice for the same payee moves the learned rule to the new account', async () => {
    const t = await feed('PURCHASE AUTHORIZED ON 05/09 SHELL OIL 11111 AUSTIN TX CARD 1234', '-12.00', '2025-05-09');
    await categorize(ctx, { bankTransactionId: t, accountId: meals });
    const learned = await learnRuleFromChoice(ctx, t);
    expect(learned).toMatchObject({ action: 'updated', accountName: 'Meals' });
    const rules = await rulesFor('SHELL OIL');
    expect(rules).toHaveLength(1);
    expect(rules[0].setAccountId).toBe(meals);
  });

  it('never changes a rule the user wrote, nor learns a choice the user turned down', async () => {
    const mine = await createBankRule(ctx, {
      name: 'Staples is office',
      matchField: 'any',
      matchOperator: 'contains',
      matchValue: 'STAPLES',
      setAccountId: office,
    });
    const t = await feed('STAPLES 0042', '-18.00');
    await categorize(ctx, { bankTransactionId: t, accountId: meals });
    expect(await learnRuleFromChoice(ctx, t)).toBeNull();
    expect((await getBankRule(ctx, mine.id)).setAccountId).toBe(office);

    await dismissOffer(ctx, { pattern: 'COFFEE HOUSE', accountId: meals, direction: 'out' });
    const c = await feed('COFFEE HOUSE', '-4.50');
    await categorize(ctx, { bankTransactionId: c, accountId: meals });
    expect(await learnRuleFromChoice(ctx, c)).toBeNull();
    expect(await rulesFor('COFFEE HOUSE')).toHaveLength(0);
  });

  it('split lines and lines a rule posted are not learned from', async () => {
    const t = await feed('COSTCO WHSE 0012', '-100.00');
    await categorize(ctx, {
      bankTransactionId: t,
      accountId: office,
      splits: [
        { accountId: office, percent: '60' },
        { accountId: meals, percent: '40' },
      ],
    });
    expect(await learnRuleFromChoice(ctx, t)).toBeNull();

    const r = await feed('AMAZON MKTPLACE', '-20.00');
    await categorize(ctx, { bankTransactionId: r, accountId: office, source: 'rule' });
    expect(await learnRuleFromChoice(ctx, r)).toBeNull();
  });

  it('accepting lines in bulk saves a rule per payee (money in learned separately from money out)', async () => {
    const dep = await feed('STRIPE TRANSFER ST-XYZ', '250.00');
    const ink = await feed('OFFICE DEPOT 7781', '-30.00');
    const res = await bulkAccept(ctx, {
      items: [
        { bankTransactionId: dep, accountId: sales },
        { bankTransactionId: ink, accountId: office },
      ],
    });
    expect(res.accepted).toHaveLength(2);
    expect(res.learnedRules.map((l) => l.accountName).sort()).toEqual(['Office Supplies', 'Sales']);
    const stripe = res.learnedRules.find((l) => l.accountName === 'Sales')!;
    expect((await getBankRule(ctx, stripe.ruleId)).direction).toBe('in');
  });
});
