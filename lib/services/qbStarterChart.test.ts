/**
 * "Replace Ironbooks' starter chart of accounts" on a QuickBooks chart import (qbStarterChart.ts):
 * the client's chart replaces the 25 starter accounts instead of landing next to them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, accounts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { importIIF, importAccountsCSV } from './qbImport';
import { postJournalEntry } from './posting';
import { iifTypeFor } from './qbStarterChart';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbstarterchart');
let db: DB;
let userId: string;
let n = 0;

async function newCompany(): Promise<ServiceContext> {
  const company = await createCompany(db, { name: `Starter Chart Co ${++n}`, ownerId: userId });
  return { db, companyId: company.id, userId };
}

async function chart(ctx: ServiceContext) {
  return db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, parentId: accounts.parentId })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
}

// A QuickBooks Desktop "Lists to IIF Files" chart, with QuickBooks' own names.
const QB_CHART = [
  '!ACCNT\tNAME\tACCNTTYPE\tACCNUM',
  'ACCNT\tFirst National Checking\tBANK\t10100',
  'ACCNT\tAccounts Receivable - Trade\tAR\t11000',
  'ACCNT\tUndeposited Funds\tOCASSET\t12000',
  'ACCNT\tAccounts Payable\tAP\t20000',
  'ACCNT\tOpening Balance Equity\tEQUITY\t30000',
  'ACCNT\tRetained Earnings\tEQUITY\t32000',
  'ACCNT\tConstruction Income\tINC\t40100',
  'ACCNT\tJob Materials\tCOGS\t50100',
  'ACCNT\tOffice Supplies\tEXP\t64900',
  'ACCNT\tOffice Supplies:Printer Ink\tEXP\t64910',
  'ACCNT\tAutomobile Expense\tEXP\t60100',
  '',
].join('\n');

describe('replace the starter chart on a QuickBooks chart import', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'starterchart@test.local', name: 'Starter Chart', passwordHash: 'x' })
      .returning();
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('IIF: the QuickBooks chart replaces the starter chart; system accounts keep their numbers', async () => {
    const ctx = await newCompany();
    const counts = await importIIF(ctx, QB_CHART, { replaceStarterChart: true });
    const rows = await chart(ctx);
    const names = rows.map((r) => r.name);
    const byCode = new Map(rows.map((r) => [r.code, r]));

    // The client's accounts are all there.
    for (const qb of [
      'First National Checking',
      'Accounts Receivable - Trade',
      'Opening Balance Equity',
      'Construction Income',
      'Job Materials',
      'Automobile Expense',
      'Printer Ink',
    ]) {
      expect(names).toContain(qb);
    }
    // System starters merged with their QuickBooks counterpart: renamed, same number, no duplicate.
    expect(byCode.get('1200')?.name).toBe('Accounts Receivable - Trade');
    expect(byCode.get('5000')?.name).toBe('Job Materials');
    expect(names.filter((x) => x === 'Accounts Receivable - Trade')).toHaveLength(1);
    expect(names).not.toContain('Accounts Receivable');
    expect(names).not.toContain('Cost of Goods Sold');
    // Same name: the starter account is used as is (one Office Supplies, the sub-account under it).
    expect(names.filter((x) => x === 'Office Supplies')).toHaveLength(1);
    expect(names.filter((x) => x === 'Undeposited Funds')).toHaveLength(1);
    expect(names.filter((x) => x === 'Accounts Payable')).toHaveLength(1);
    expect(names.filter((x) => x === 'Retained Earnings')).toHaveLength(1);
    // Starter accounts the client doesn't have are gone…
    for (const gone of ['Checking', 'Savings', "Owner's Equity", 'Advertising & Marketing', 'Service Income', 'Rent', 'Credit Card']) {
      expect(names).not.toContain(gone);
    }
    // …except the ones Ironbooks posts to by number.
    for (const code of ['1050', '1200', '1300', '2000', '2200', '2300', '3900', '4000', '5000', '6500']) {
      expect(byCode.has(code)).toBe(true);
    }
    expect(counts.issues.some((i) => /starter accounts .* were removed/.test(i.message ?? ''))).toBe(true);
  });

  it('IIF: QuickBooks alias type codes (ARACCNT, EXPENSE) merge the same way', async () => {
    const ctx = await newCompany();
    await importIIF(
      ctx,
      ['!ACCNT\tNAME\tACCNTTYPE', 'ACCNT\tA/R Clients\tARACCNT', 'ACCNT\tCar & Truck\tEXPENSE', ''].join('\n'),
      { replaceStarterChart: true },
    );
    const rows = await chart(ctx);
    expect(rows.find((r) => r.code === '1200')?.name).toBe('A/R Clients');
    expect(rows.filter((r) => r.name === 'A/R Clients')).toHaveLength(1);
    // No bank account in the file: 1000 Checking stays (the company still needs one to start).
    expect(rows.some((r) => r.code === '1000' && r.name === 'Checking')).toBe(true);
  });

  it('IIF without the option: the starter chart stays (previous behaviour)', async () => {
    const ctx = await newCompany();
    await importIIF(ctx, QB_CHART);
    const names = (await chart(ctx)).map((r) => r.name);
    expect(names).toContain('Advertising & Marketing');
    expect(names).toContain('Accounts Receivable');
    expect(names).toContain('Accounts Receivable - Trade');
  });

  it('never deletes a starter account that was already used; reports it instead', async () => {
    const ctx = await newCompany();
    const before = await chart(ctx);
    const id = (code: string) => before.find((r) => r.code === code)!.id;
    await postJournalEntry(ctx, {
      date: new Date('2025-01-15'),
      description: 'used before the import',
      lines: [
        { accountId: id('6000'), debit: '50.00' },
        { accountId: id('1000'), credit: '50.00' },
      ],
    });
    const counts = await importIIF(ctx, QB_CHART, { replaceStarterChart: true });
    const names = (await chart(ctx)).map((r) => r.name);
    expect(names).toContain('Advertising & Marketing');
    expect(names).toContain('Checking');
    expect(names).not.toContain('Rent');
    const kept = counts.issues.find((i) => /Kept because they are already in use/.test(i.message ?? ''));
    expect(kept?.message).toContain('6000 Advertising & Marketing');
    expect(kept?.message).toContain('1000 Checking');
  });

  it('CSV chart of accounts: replaces the starter chart the same way', async () => {
    const ctx = await newCompany();
    const csv = [
      'Account,Type,Number',
      'Operating Account,Bank,10100',
      'Accounts Receivable,Accounts Receivable,11000',
      'Trade Payables,Accounts Payable,20000',
      'Consulting Revenue,Income,40000',
      'Rent Expense,Expense,62000',
      '',
    ].join('\n');
    await importAccountsCSV(ctx, csv, { name: 'Account', type: 'Type', code: 'Number' }, { replaceStarterChart: true });
    const rows = await chart(ctx);
    const names = rows.map((r) => r.name);
    expect(names).toContain('Operating Account');
    expect(names).toContain('Consulting Revenue');
    expect(rows.find((r) => r.code === '2000')?.name).toBe('Trade Payables');
    expect(names.filter((x) => x === 'Accounts Receivable')).toHaveLength(1);
    for (const gone of ['Checking', 'Rent', 'Advertising & Marketing', "Owner's Equity"]) {
      expect(names).not.toContain(gone);
    }
  });

  it('iifTypeFor maps Ironbooks types back to QuickBooks type codes', () => {
    expect(iifTypeFor('asset', 'checking')).toBe('BANK');
    expect(iifTypeFor('asset', 'accounts_receivable')).toBe('AR');
    expect(iifTypeFor('asset', 'inventory')).toBe('OCASSET');
    expect(iifTypeFor('liability', 'accounts_payable')).toBe('AP');
    expect(iifTypeFor('liability', 'credit_card')).toBe('CCARD');
    expect(iifTypeFor('equity', 'retained_earnings')).toBe('EQUITY');
    expect(iifTypeFor('revenue', 'other_income')).toBe('EXINC');
    expect(iifTypeFor('expense', 'cost_of_goods_sold')).toBe('COGS');
    expect(iifTypeFor('expense', 'operating_expenses')).toBe('EXP');
  });
});
