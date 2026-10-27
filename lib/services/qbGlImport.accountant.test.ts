/**
 * Feature round (accountant team) — review round 5 leftover (reports -> imports): the Trial
 * Balance proof of a QuickBooks General Ledger import compared the imported ALL-TIME account
 * balances with the QuickBooks Trial Balance. QuickBooks' Trial Balance shows income and expense
 * accounts for the fiscal year to date and puts the earlier years' net income in Retained Earnings,
 * so a GL import spanning more than one fiscal year, checked against its Trial Balance, always
 * failed ("Nothing was saved"). The proof now reads the imported books the way QuickBooks prints
 * its Trial Balance. Failed before the fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import Papa from 'papaparse';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { runGlImport } from './qbGlImport';
import { SAMPLE_GL, fmtMoney, fxByNumber, fxEnding, fxFullName, glCsv, upload, type GlFixture } from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbglimport-accountant');
let db: DB;
let userId: string;

/** SAMPLE_GL with a year of 2023 activity before it: the GL runs Jan 1, 2023 – Mar 31, 2024. */
const TWO_YEARS: GlFixture = {
  ...SAMPLE_GL,
  periodLabel: 'January 1, 2023 through March 31, 2024',
  txns: [
    { type: 'Invoice', date: '06/01/2023', num: '901', name: 'Acme Corp', lines: [
      { acct: '11000', amount: '1000.00' },
      { acct: '40100', amount: '-1000.00', memo: 'Consulting 2023' },
    ] },
    { type: 'Payment', date: '06/20/2023', num: '902', name: 'Acme Corp', lines: [
      { acct: '10100', amount: '1000.00' },
      { acct: '11000', amount: '-1000.00' },
    ] },
    { type: 'Check', date: '07/01/2023', num: '903', name: 'Landlord LLC', lines: [
      { acct: '10100', amount: '-400.00' },
      { acct: '62000', amount: '400.00' },
    ] },
    ...SAMPLE_GL.txns,
  ],
};

const PNL = new Set(['Income', 'Cost of Goods Sold', 'Expense', 'Other Income', 'Other Expense']);

/** The Trial Balance QuickBooks prints as of Mar 31, 2024: P&L for 2024 only, 2023's in Retained Earnings. */
function qbTrialBalanceCsv(fx: GlFixture): string {
  const end = fxEnding(fx);
  const byNum = fxByNumber(fx);
  let prior = Money.zero();
  for (const t of fx.txns) {
    if (!t.date.endsWith('2023')) continue;
    for (const l of t.lines) {
      if (!PNL.has(byNum.get(l.acct)!.type)) continue;
      end.set(l.acct, end.get(l.acct)!.minus(l.amount));
      prior = prior.plus(l.amount);
    }
  }
  end.set('32000', end.get('32000')!.plus(prior));
  const rows: string[][] = [[fx.company], ['Trial Balance'], ['As of March 31, 2024'], ['', 'Mar 31, 24', ''], ['', 'Debit', 'Credit']];
  for (const a of fx.accounts) {
    const b = end.get(a.number)!;
    if (b.isZero()) continue;
    rows.push([fxFullName(fx, a.number, true), b.isPositive() ? fmtMoney(b) : '', b.isNegative() ? fmtMoney(b.negated()) : '']);
  }
  rows.push(['TOTAL', '', '']);
  return Papa.unparse(rows);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'qbgl-acct@test.local', name: 'QbGl', passwordHash: 'x' }).returning();
  userId = user.id;
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function newCompany(name: string): Promise<ServiceContext> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId, settings: { fiscalYearEnd: '12-31' } }).returning();
  return { db, companyId: company.id, userId };
}

describe('GL import: the Trial Balance proof across fiscal years', () => {
  it('a two-year GL agrees with the QuickBooks Trial Balance (P&L year to date, earlier years in Retained Earnings)', async () => {
    const ctx = await newCompany('Two Years Co');
    const r = await runGlImport(ctx, { file: upload('gl.csv', glCsv(TWO_YEARS)), references: [upload('tb.csv', qbTrialBalanceCsv(TWO_YEARS))] });
    expect(r.message).not.toMatch(/Trial Balance doesn't agree/);
    expect(r.ok).toBe(true);
    expect(r.proof.trialBalanceCompared).toBe(true);
    expect(r.proof.trialBalanceMatches).toBe(true);
    expect(r.proof.rows.every((row) => row.trialBalanceDifference === null || row.trialBalanceDifference === '0.00')).toBe(true);
  });

  it('a real difference is still caught', async () => {
    const ctx = await newCompany('Two Years Mismatch Co');
    const csv = qbTrialBalanceCsv(TWO_YEARS).replace('"1,900.00"', '"1,901.00"');
    const tb = csv.includes('1,901.00') ? csv : qbTrialBalanceCsv({ ...TWO_YEARS, accounts: TWO_YEARS.accounts.map((a) => (a.number === '10200' ? { ...a, begin: '10001.00' } : a)) });
    const r = await runGlImport(ctx, { file: upload('gl.csv', glCsv(TWO_YEARS)), references: [upload('tb.csv', tb)] });
    expect(r.ok).toBe(false);
    expect(r.proof.trialBalanceMatches).toBe(false);
  });
});
