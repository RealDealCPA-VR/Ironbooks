/**
 * End-to-end tests for the QuickBooks General Ledger migration (lib/services/qbGlImport.ts) on a
 * hermetic PGlite database: import → trial balance equals the source report, idempotent
 * re-import, dry runs leave no trace, an unbalanced report lands in review and rolls back unless
 * the variance is explicitly accepted into 'QB Import Suspense'.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  classes,
  companies,
  customers,
  employees,
  journalEntries,
  journalEntryLines,
  qbGlImports,
  users,
  vendors,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createManualEntry } from './journal';
import { listGlImports, previewGlImport, runGlImport, QB_SUSPENSE } from './qbGlImport';
import {
  SAMPLE_GL,
  accountListCsv,
  fxEnding,
  glCsv,
  glPdf,
  glXlsx,
  trialBalanceCsv,
  upload,
} from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbglimport');

let db: DB;
let userId: string;

async function newCompany(name: string): Promise<ServiceContext> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  return { db, companyId: company.id, userId };
}

/** Debit-positive balance per account code, from the journal (posted entries only). */
async function balancesByCode(ctx: ServiceContext): Promise<Map<string, string>> {
  const rows = await ctx.db
    .select({
      code: accounts.code,
      dr: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      cr: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')))
    .groupBy(accounts.code);
  return new Map(rows.map((r) => [r.code, Money.of(r.dr).minus(Money.of(r.cr)).toFixed(2)]));
}

async function entryCount(ctx: ServiceContext): Promise<number> {
  const [r] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, ctx.companyId));
  return r.n;
}

describe('qbGlImport — QuickBooks General Ledger migration', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qbgl@test.local', name: 'QbGl', passwordHash: 'x' })
      .returning();
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imports a CSV GL: chart, lists, opening entry, transactions — trial balance equals the source', async () => {
    const ctx = await newCompany('CSV Co');
    // An existing account with the same name is reused instead of duplicated.
    await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' });

    const file = upload('General Ledger.csv', glCsv(SAMPLE_GL));
    const preview = await previewGlImport(ctx, { file });
    expect(preview.errors).toEqual([]);
    expect(preview.stats.transactions).toBe(SAMPLE_GL.txns.length);
    expect(preview.meta.periodStart).toBe('2024-01-01');
    const checking = preview.accounts.find((a) => a.number === '10100')!;
    expect(checking.match).toMatchObject({ code: '1000', reason: 'same name and type' });

    const result = await runGlImport(ctx, { file });
    expect(result.message).toMatch(/Imported/);
    expect(result.ok).toBe(true);
    expect(result.proof.allMatch).toBe(true);
    expect(result.proof.ledger.balanced).toBe(true);
    expect(result.counts.entriesPosted).toBe(SAMPLE_GL.txns.length);
    expect(result.counts.openingEntryPosted).toBe(true);
    expect(result.counts.accountsMapped).toBe(1);
    expect(result.counts.accountsCreated).toBe(SAMPLE_GL.accounts.length - 1);

    // Every account's balance equals the report's ending balance.
    const bal = await balancesByCode(ctx);
    for (const [num, end] of fxEnding(SAMPLE_GL)) {
      const code = num === '10100' ? '1000' : num;
      expect([num, bal.get(code) ?? '0.00']).toEqual([num, end.toFixed(2)]);
    }

    // Opening entry dated the day before the period.
    const [open] = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'qbgl:open:%')));
    expect(open.date.toISOString().slice(0, 10)).toBe('2023-12-31');

    // Hierarchy + numbers.
    const accts = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const fuel = accts.find((a) => a.code === '60100')!;
    const auto = accts.find((a) => a.code === '60000')!;
    expect(fuel.parentId).toBe(auto.id);
    expect(fuel.name).toBe('Fuel');
    expect(accts.find((a) => a.code === '20000')).toMatchObject({ type: 'liability', subtype: 'accounts_payable' });
    expect(accts.find((a) => a.code === '32000')).toMatchObject({ type: 'equity', subtype: 'retained_earnings' });
    // Cached balances agree with the ledger.
    for (const a of accts) expect([a.code, Money.of(a.balance).abs().toFixed(2)]).toEqual([a.code, Money.of(bal.get(a.code) ?? 0).abs().toFixed(2)]);

    // Classes (with hierarchy) and names.
    const cls = await db.select().from(classes).where(eq(classes.companyId, ctx.companyId));
    const admin = cls.find((c) => c.name === 'Admin')!;
    expect(cls.find((c) => c.name === 'Payroll')!.parentId).toBe(admin.id);
    const cust = await db.select().from(customers).where(eq(customers.companyId, ctx.companyId));
    const acme = cust.find((c) => c.displayName === 'Acme Corp')!;
    expect(cust.find((c) => c.displayName === 'Acme Corp:Kitchen Remodel')!.parentId).toBe(acme.id);
    const vend = await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId));
    expect(vend.map((v) => v.displayName).sort()).toEqual(
      ['City Parking', 'Home Depot', 'IRS', "Joe's Garage", 'Landlord LLC', 'Office Depot', 'Shell Oil', 'Staples'].sort(),
    );
    const emp = await db.select().from(employees).where(eq(employees.companyId, ctx.companyId));
    expect(emp.map((e) => [e.firstName, e.lastName])).toEqual([['John', 'Smith']]);

    // Class tags made it onto the lines.
    const tagged = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(and(eq(journalEntries.companyId, ctx.companyId), sql`${journalEntryLines.classId} IS NOT NULL`));
    expect(tagged[0].n).toBe(12);

    // The proof is stored with the import.
    const history = await listGlImports(ctx);
    expect(history).toHaveLength(1);
    expect(history[0].entriesPosted).toBe(SAMPLE_GL.txns.length);

    // Re-importing the same report changes nothing.
    const before = await entryCount(ctx);
    const again = await runGlImport(ctx, { file });
    expect(again.ok).toBe(true);
    expect(again.counts.entriesPosted).toBe(0);
    expect(again.counts.entriesAlreadyImported).toBe(SAMPLE_GL.txns.length);
    expect(again.counts.openingEntryPosted).toBe(false);
    expect(again.counts.accountsCreated).toBe(0);
    expect(again.proof.allMatch).toBe(true);
    expect(await entryCount(ctx)).toBe(before);
    expect(await balancesByCode(ctx)).toEqual(bal);

    // …and so does the same books exported as xlsx or PDF.
    for (const f of [upload('gl.xlsx', glXlsx(SAMPLE_GL)), upload('gl.pdf', await glPdf(SAMPLE_GL))]) {
      const r = await runGlImport(ctx, { file: f });
      expect(r.ok).toBe(true);
      expect(r.counts.entriesPosted).toBe(0);
    }
    expect(await entryCount(ctx)).toBe(before);
  });

  it('dry run proves the import without saving anything', async () => {
    const ctx = await newCompany('Dry Co');
    const file = upload('gl.xlsx', glXlsx(SAMPLE_GL));
    const r = await runGlImport(ctx, { file, references: [upload('accounts.csv', accountListCsv(SAMPLE_GL))] }, { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.rolledBack).toBe(true);
    expect(r.proof.allMatch).toBe(true);
    expect(r.counts.entriesPosted).toBe(SAMPLE_GL.txns.length);
    expect(await entryCount(ctx)).toBe(0);
    const accts = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    expect(accts).toHaveLength(0);
    expect(await db.select().from(qbGlImports).where(eq(qbGlImports.companyId, ctx.companyId))).toHaveLength(0);
  });

  it('PDF import with a QB Trial Balance: reconciles to the TB as well', async () => {
    const ctx = await newCompany('PDF Co');
    const r = await runGlImport(ctx, {
      file: upload('gl.pdf', await glPdf(SAMPLE_GL)),
      references: [upload('tb.csv', trialBalanceCsv(SAMPLE_GL))],
    });
    expect(r.ok).toBe(true);
    expect(r.proof.trialBalanceCompared).toBe(true);
    expect(r.proof.trialBalanceMatches).toBe(true);
    expect(r.proof.rows.every((row) => row.trialBalanceDifference === '0.00')).toBe(true);
  });

  it('rolls back when the QB Trial Balance disagrees, even when a variance is accepted', async () => {
    const ctx = await newCompany('TB Mismatch Co');
    const tb = upload('tb.csv', trialBalanceCsv(SAMPLE_GL, { acct: '64000', by: '1.00' }));
    const r = await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)), references: [tb] });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.proof.trialBalanceMatches).toBe(false);
    expect(r.message).toMatch(/Trial Balance/);
    expect(await entryCount(ctx)).toBe(0);

    // A TB difference can't be reconciled through the GL, so accepting a variance doesn't apply.
    const accepted = await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)), references: [tb], acceptVariance: true });
    expect(accepted.ok).toBe(false);
    expect(accepted.rolledBack).toBe(true);
    expect(accepted.variancePosted).toBeNull();
    expect(accepted.message).toMatch(/Trial Balance/);
    expect(await entryCount(ctx)).toBe(0);
    expect(await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).toHaveLength(0);
  });

  it('an unbalanced report lands in review, rolls back, and only posts to suspense when accepted', async () => {
    const ctx = await newCompany('Unbalanced Co');
    const idx = SAMPLE_GL.txns.findIndex((t) => t.memo === 'Interest');
    const file = upload('gl.csv', glCsv(SAMPLE_GL, { dropLine: { txn: idx, line: 1 } }));

    const preview = await previewGlImport(ctx, { file });
    expect(preview.errors).toEqual([]);
    expect(preview.review).toHaveLength(1);

    const refused = await runGlImport(ctx, { file });
    expect(refused.ok).toBe(false);
    expect(refused.rolledBack).toBe(true);
    expect(refused.review).toHaveLength(1);
    const savings = refused.proof.rows.find((r) => r.code === '10200')!;
    expect(savings.difference).toBe('12.34');
    expect(await entryCount(ctx)).toBe(0);
    expect(await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).toHaveLength(0);

    const accepted = await runGlImport(ctx, { file, acceptVariance: true });
    expect(accepted.ok).toBe(true);
    expect(accepted.variancePosted).toBe('12.34');
    expect(accepted.proof.allMatch).toBe(true);
    expect(accepted.proof.suspense).toBe('-12.34');
    expect(accepted.proof.ledger.balanced).toBe(true);
    expect(accepted.counts.entriesPosted).toBe(SAMPLE_GL.txns.length - 1);
    const [suspense] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, QB_SUSPENSE.code)));
    expect(suspense.name).toBe('QB Import Suspense');
    const bal = await balancesByCode(ctx);
    expect(bal.get('10200')).toBe(fxEnding(SAMPLE_GL).get('10200')!.toFixed(2));
  });

  it('refuses a report with blocking problems and explains why', async () => {
    const ctx = await newCompany('Bad Co');
    const csv = glCsv(SAMPLE_GL).replace('"25,000.00"', '"26,000.00"');
    await expect(runGlImport(ctx, { file: upload('gl.csv', csv) })).rejects.toThrow(/can't be imported/);
    await expect(runGlImport(ctx, { file: upload('x.csv', 'hello,world\n1,2') })).rejects.toThrow(/General Ledger/);
    expect(await entryCount(ctx)).toBe(0);
  });

  it('lets the user override account types and map onto existing accounts', async () => {
    const ctx = await newCompany('Mapping Co');
    const existing = await createAccount(ctx, { code: '6999', name: 'Car Costs', type: 'expense', subtype: 'operating_expenses' });
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    const preview = await previewGlImport(ctx, { file });
    const fuel = preview.accounts.find((a) => a.number === '60100')!;
    const savings = preview.accounts.find((a) => a.number === '10200')!;
    const r = await runGlImport(ctx, {
      file,
      accounts: {
        [fuel.key]: { mapTo: existing.id },
        [savings.key]: { qbType: 'Other Current Asset' },
      },
    });
    expect(r.ok).toBe(true);
    const bal = await balancesByCode(ctx);
    expect(bal.get('6999')).toBe(fxEnding(SAMPLE_GL).get('60100')!.toFixed(2));
    const [sav] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '10200')));
    // An Other Current Asset is no longer stored as a bank account (wave2 foundation, B1).
    expect(sav.subtype).toBe('other_current_asset');
  });

  it('warns when a mapped account also holds entries that were not imported', async () => {
    const ctx = await newCompany('Drift Co');
    const car = await createAccount(ctx, { code: '6999', name: 'Car Costs', type: 'expense', subtype: 'operating_expenses' });
    const petty = await createAccount(ctx, { code: '1999', name: 'Petty Cash', type: 'asset', subtype: 'checking' });
    await createManualEntry(ctx, {
      date: new Date(Date.UTC(2024, 0, 2)),
      description: 'Parking',
      lines: [
        { accountId: car.id, debit: '50.00' },
        { accountId: petty.id, credit: '50.00' },
      ],
    });
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    const preview = await previewGlImport(ctx, { file });
    expect(preview.otherPostedEntries).toBe(1);
    const fuel = preview.accounts.find((a) => a.number === '60100')!;
    const r = await runGlImport(ctx, { file, accounts: { [fuel.key]: { mapTo: car.id } } });
    expect(r.ok).toBe(true);
    expect(r.proof.allMatch).toBe(true);
    expect(r.warnings.some((w) => /weren't part of this import/.test(w) && w.includes('6999'))).toBe(true);
  });

  it('imports consecutive periods without doubling the opening balances', async () => {
    const ctx = await newCompany('Periods Co');
    const q1 = await runGlImport(ctx, { file: upload('q1.csv', glCsv(SAMPLE_GL)) });
    expect(q1.ok).toBe(true);
    // Q2 report: beginning balances = Q1 ending; one new transaction.
    const end = fxEnding(SAMPLE_GL);
    const q2 = {
      ...SAMPLE_GL,
      periodLabel: 'April 1 through June 30, 2024',
      accounts: SAMPLE_GL.accounts.map((a) => ({ ...a, begin: end.get(a.number)!.toFixed(2) })),
      txns: [{ type: 'Check', date: '04/02/2024', num: '1010', name: 'Landlord LLC', lines: [
        { acct: '10100', amount: '-1500.00' },
        { acct: '62000', amount: '1500.00' },
      ] }],
    };
    const r = await runGlImport(ctx, { file: upload('q2.csv', glCsv(q2)) });
    expect(r.ok).toBe(true);
    expect(r.counts.openingEntryPosted).toBe(false);
    expect(r.counts.entriesPosted).toBe(1);
    const bal = await balancesByCode(ctx);
    expect(bal.get('10100')).toBe(end.get('10100')!.minus(1500).toFixed(2));
  });
});
