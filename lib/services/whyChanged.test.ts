/**
 * "Why did this number change?" — lists the transactions created, edited, voided since a moment
 * that moved an account set / report total, with correct before / after / delta and who.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { createExpense } from './expenses';
import { createManualEntry, updateEntry } from './journal';
import { whyChanged } from './whyChanged';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-why-changed');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let since: Date;
let tbBefore: string;
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inv = (amount: string, date = '2026-03-01') => ({
  customerId,
  date: d(date),
  lines: [{ accountId: acct['4000'], description: 'Work', quantity: '1', rate: amount, taxable: false }],
});

describe('whyChanged', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'why@test.local', name: 'Dana', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Why Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6300', 'Supplies', 'expense', 'operating_expenses'],
      ['6400', 'Rent', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Acme' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Depot' }).returning())[0].id;
    await createManualEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '5000.00' },
        { accountId: acct['3000'], credit: '5000.00' },
      ],
    });
    ids.a = (await createInvoice(ctx, inv('100.00'))).id;
    ids.c = (await createInvoice(ctx, inv('30.00'))).id;
    ids.je = (
      await createManualEntry(ctx, {
        date: d('2026-02-01'),
        description: 'Reclass',
        lines: [
          { accountId: acct['6400'], debit: '20.00' },
          { accountId: acct['1000'], credit: '20.00' },
        ],
      })
    ).id;
    tbBefore = (await trialBalance(ctx)).totalDebit;

    await pause(30);
    since = new Date();
    await pause(30);

    await updateInvoice(ctx, ids.a, inv('150.00'));
    ids.b = (await createInvoice(ctx, inv('40.00', '2026-04-15'))).id;
    await voidInvoice(ctx, ids.c);
    await createExpense(ctx, {
      vendorId,
      date: d('2026-03-10'),
      method: 'check',
      reference: '7',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '25.00' }],
    });
    await updateEntry(ctx, ids.je, {
      date: d('2026-02-01'),
      description: 'Reclass (fixed)',
      lines: [
        { accountId: acct['6400'], debit: '35.00' },
        { accountId: acct['1000'], credit: '35.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; next run wipes it. */
    }
  });

  it('income total: an edit, a new invoice and a void, each with before / after / delta and who', async () => {
    const r = await whyChanged(ctx, { since, preset: 'income' });
    const byDelta = Object.fromEntries(r.changes.map((c) => [c.delta, c]));
    expect(r.changes).toHaveLength(3);
    expect(byDelta['50.00']).toMatchObject({ kind: 'edited', before: '100.00', after: '150.00', type: 'invoice', who: 'Dana' });
    expect(byDelta['40.00']).toMatchObject({ kind: 'created', before: '0.00', after: '40.00' });
    expect(byDelta['-30.00']).toMatchObject({ kind: 'voided', before: '30.00', after: '0.00' });
    expect(r.totalDelta).toBe('60.00');
    expect(r.totalNow).toBe('190.00');
    expect(r.totalThen).toBe('130.00');
  });

  it('an account balance (A/R) lists the same documents; the expense does not touch it', async () => {
    const r = await whyChanged(ctx, { since, accountIds: [acct['1200']] });
    expect(r.changes.map((c) => c.delta).sort()).toEqual(['-30.00', '40.00', '50.00']);
    expect(r.changes.every((c) => c.type === 'invoice')).toBe(true);
  });

  it('respects the report date window', async () => {
    const r = await whyChanged(ctx, { since, preset: 'income', from: '2026-03-01', to: '2026-03-31' });
    expect(r.changes.map((c) => c.delta).sort()).toEqual(['-30.00', '50.00']);
    expect(r.totalNow).toBe('150.00');
  });

  it('a journal entry edit (replacement entry) shows as one edited row; expenses count once', async () => {
    const r = await whyChanged(ctx, { since, preset: 'expenses' });
    const je = r.changes.find((c) => c.type === 'journal entry');
    expect(je).toMatchObject({ kind: 'edited', before: '20.00', after: '35.00', delta: '15.00' });
    const check = r.changes.find((c) => c.type === 'check / expense');
    expect(check).toMatchObject({ kind: 'created', delta: '25.00' });
    expect(r.changes).toHaveLength(2);
    expect(r.totalDelta).toBe('40.00');
  });

  it('net income reads credit-positive; Trial Balance total compares exactly to the earlier total', async () => {
    const ni = await whyChanged(ctx, { since, preset: 'net_income' });
    expect(ni.totalDelta).toBe('20.00'); // +60 income, -40 expenses
    const tb = await whyChanged(ctx, { since, preset: 'all' });
    expect(tb.totalThen).toBe(tbBefore);
    expect(tb.totalNow).toBe((await trialBalance(ctx)).totalDebit);
    expect(tb.changes.length).toBeGreaterThan(0);
  });

  it('nothing changed since now', async () => {
    const r = await whyChanged(ctx, { since: new Date(Date.now() + 60_000), preset: 'assets' });
    expect(r.changes).toHaveLength(0);
    expect(r.totalDelta).toBe('0.00');
  });

  it('refuses bad input', async () => {
    await expect(whyChanged(ctx, { since: new Date('x'), preset: 'assets' })).rejects.toThrow(/since/);
    await expect(whyChanged(ctx, { since })).rejects.toThrow(/Choose an account/);
    await expect(whyChanged(ctx, { since, accountIds: ['nope'] })).rejects.toThrow(/not valid/);
  });
});
