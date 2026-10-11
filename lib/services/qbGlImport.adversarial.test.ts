/**
 * Adversarial QA for the QuickBooks General Ledger migration (qbGlImport.ts / qbGlParse.ts /
 * qbGlFiles.ts), written independently of the implementation's own tests. Covers: permission
 * bypass (viewer role), closed books + full rollback, cross-company ids, account-number
 * collisions, identical duplicate transactions, edited re-imports, voids, penny rounding with
 * 3-level sub-accounts across CSV/xlsx/PDF, float-noise spreadsheet numbers, malformed uploads,
 * Split contradictions that must not be silently forced, and accepted-variance semantics.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import Papa from 'papaparse';
import { and, eq, like, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  classes,
  companies,
  customers,
  journalEntries,
  journalEntryLines,
  qbGlImports,
  users,
  vendors,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { previewGlImport, runGlImport, QB_SUSPENSE } from './qbGlImport';
import { columnIndex, excelSerialToDate, loadGrid, readXlsx } from './qbGlFiles';
import { analyzeGl, parseAmount, parseGlSheets, parseQbDate } from './qbGlParse';
import {
  SAMPLE_GL,
  fxEnding,
  glColumns,
  glCsv,
  glGrid,
  glPdf,
  glXlsx,
  trialBalanceCsv,
  upload,
  type GlFixture,
} from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbglimport-adv');

let db: DB;
let userId: string;

async function newCompany(name: string): Promise<ServiceContext> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  return { db, companyId: company.id, userId };
}

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

async function counts(ctx: ServiceContext) {
  const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0].n;
  const c = sql<number>`count(*)::int`;
  return {
    entries: await n(db.select({ n: c }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))),
    accounts: await n(db.select({ n: c }).from(accounts).where(eq(accounts.companyId, ctx.companyId))),
    classes: await n(db.select({ n: c }).from(classes).where(eq(classes.companyId, ctx.companyId))),
    customers: await n(db.select({ n: c }).from(customers).where(eq(customers.companyId, ctx.companyId))),
    vendors: await n(db.select({ n: c }).from(vendors).where(eq(vendors.companyId, ctx.companyId))),
    imports: await n(db.select({ n: c }).from(qbGlImports).where(eq(qbGlImports.companyId, ctx.companyId))),
  };
}

/** Every posted entry balances, and the whole ledger's debits equal its credits. */
async function assertLedgerInvariants(ctx: ServiceContext) {
  const perEntry = await db
    .select({
      id: journalEntries.id,
      dr: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      cr: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntries)
    .innerJoin(journalEntryLines, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')))
    .groupBy(journalEntries.id);
  for (const e of perEntry) expect([e.id, Money.of(e.dr).toFixed(2)]).toEqual([e.id, Money.of(e.cr).toFixed(2)]);
  const bal = await balancesByCode(ctx);
  const sum = [...bal.values()].reduce((s, v) => s.plus(v), Money.zero());
  expect(sum.toFixed(2)).toBe('0.00');
}

/** A grid → CSV with one cell rewritten where `pick(row)` matches. */
function csvWithSplit(fx: GlFixture, edits: Array<{ match: (row: string[]) => boolean; split: string }>): string {
  const cols = glColumns();
  const splitCol = 3 + cols.indexOf('split');
  const grid = glGrid(fx);
  for (const row of grid) for (const e of edits) if (e.match(row)) row[splitCol] = e.split;
  return Papa.unparse(grid);
}

/** Pennies, a 3-level sub-account chain, classes, and a 3-way 33.33/33.33/33.34 split. */
const CENTS_GL: GlFixture = {
  company: 'Pennies Ltd',
  periodLabel: 'January 1 through March 31, 2024',
  accounts: [
    { number: '1000', name: 'Operating Bank', type: 'Bank', begin: '1000.01' },
    { number: '1200', name: 'Accounts Receivable', type: 'Accounts Receivable', begin: '0.00' },
    { number: '3000', name: 'Owner Capital', type: 'Equity', begin: '-1000.01' },
    { number: '4000', name: 'Service Revenue', type: 'Income', begin: '0.00' },
    { number: '6000', name: 'Office Expense', type: 'Expense', begin: '0.00' },
    { number: '6010', name: 'Supplies', type: 'Expense', parent: '6000', begin: '0.00' },
    { number: '6011', name: 'Paper', type: 'Expense', parent: '6010', begin: '0.00' },
  ],
  txns: [
    { type: 'Invoice', date: '01/03/2024', num: 'I-1', name: 'Tiny Client', lines: [
      { acct: '1200', amount: '100.00' },
      { acct: '4000', amount: '-33.33', cls: 'North', memo: 'part 1' },
      { acct: '4000', amount: '-33.33', cls: 'South', memo: 'part 2' },
      { acct: '4000', amount: '-33.34', cls: 'North:Metro', memo: 'part 3' },
    ] },
    { type: 'Payment', date: '01/20/2024', num: 'P-1', name: 'Tiny Client', lines: [
      { acct: '1000', amount: '100.00' },
      { acct: '1200', amount: '-100.00' },
    ] },
    ...Array.from({ length: 31 }, (_, i) => ({
      type: 'Check',
      date: `02/${String((i % 28) + 1).padStart(2, '0')}/2024`,
      num: String(2000 + i),
      name: 'Paper Co',
      lines: [
        { acct: '1000', amount: '-0.10' },
        { acct: i % 2 ? '6011' : '6010', amount: '0.10' },
      ],
    })),
    { type: 'Check', date: '03/01/2024', num: '3000', name: 'Paper Co', lines: [
      { acct: '1000', amount: '-0.01' },
      { acct: '6000', amount: '0.01' },
    ] },
  ],
};

describe('qbGlImport — adversarial QA', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qbgl-adv@test.local', name: 'QbGlAdv', passwordHash: 'x' })
      .returning();
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a view-only user cannot import (nor dry-run), and nothing is written', async () => {
    const ctx = await newCompany('Viewer Co');
    const viewer: ServiceContext = { ...ctx, role: 'viewer' };
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    // Preview is read-only and allowed.
    const preview = await previewGlImport(viewer, { file });
    expect(preview.errors).toEqual([]);
    await expect(runGlImport(viewer, { file })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runGlImport(viewer, { file }, { dryRun: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runGlImport(viewer, { file, acceptVariance: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await counts(ctx)).toEqual({ entries: 0, accounts: 0, classes: 0, customers: 0, vendors: 0, imports: 0 });
  });

  it('closed books: refuses with PERIOD_CLOSED and rolls back accounts, classes and names too', async () => {
    const ctx = await newCompany('Closed Co');
    await db.update(companies).set({ settings: { closingDate: '2024-02-15' } }).where(eq(companies.id, ctx.companyId));
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    await expect(runGlImport(ctx, { file })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(await counts(ctx)).toEqual({ entries: 0, accounts: 0, classes: 0, customers: 0, vendors: 0, imports: 0 });
    // With the closing-date password the import goes through and reconciles.
    const ok = await runGlImport({ ...ctx, closingDateOverride: true }, { file });
    expect(ok.ok).toBe(true);
    expect(ok.proof.allMatch).toBe(true);
  });

  it('rejects mapping onto an account that belongs to a different company', async () => {
    const other = await newCompany('Other Co');
    const foreign = await createAccount(other, { code: '9999', name: 'Foreign', type: 'expense', subtype: 'operating_expenses' });
    const ctx = await newCompany('Mine Co');
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    const preview = await previewGlImport(ctx, { file });
    const rent = preview.accounts.find((a) => a.number === '62000')!;
    const attempt = runGlImport(ctx, { file, accounts: { [rent.key]: { mapTo: foreign.id } } });
    await expect(attempt).rejects.toBeInstanceOf(ServiceError);
    await expect(runGlImport(ctx, { file, accounts: { [rent.key]: { mapTo: foreign.id } } })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [f] = await db.select().from(accounts).where(eq(accounts.id, foreign.id));
    expect(Money.of(f.balance).toFixed(2)).toBe('0.00');
    expect((await counts(ctx)).entries).toBe(0);
  });

  it('account number already used by a different account: no hijack, created under a new code, ledger exact', async () => {
    const ctx = await newCompany('Collision Co');
    const tel = await createAccount(ctx, { code: '64000', name: 'Telephone', type: 'expense', subtype: 'operating_expenses' });
    const r = await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)) });
    expect(r.ok).toBe(true);
    const all = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const supplies = all.find((a) => a.name === 'Office Supplies')!;
    expect(supplies.code).not.toBe('64000');
    expect(supplies.id).not.toBe(tel.id);
    const bal = await balancesByCode(ctx);
    expect(bal.get('64000') ?? '0.00').toBe('0.00'); // Telephone untouched
    expect(bal.get(supplies.code)).toBe(fxEnding(SAMPLE_GL).get('64000')!.toFixed(2));
    expect(r.warnings.some((w) => w.includes('64000'))).toBe(true);
    await assertLedgerInvariants(ctx);
  });

  it('two identical transactions (same type/date/payee/amount, no number) are both posted, and re-import adds none', async () => {
    const fx: GlFixture = {
      company: 'Twins Co',
      periodLabel: 'January 1 through January 31, 2024',
      accounts: [
        { number: '1000', name: 'Checking', type: 'Bank', begin: '500.00' },
        { number: '3000', name: 'Owner Equity', type: 'Equity', begin: '-500.00' },
        { number: '6000', name: 'Office Supplies', type: 'Expense', begin: '0.00' },
      ],
      txns: [1, 2, 3].map(() => ({
        type: 'Check', date: '01/10/2024', name: 'Staples', memo: 'Pens', lines: [
          { acct: '1000', amount: '-50.00' },
          { acct: '6000', amount: '50.00' },
        ],
      })),
    };
    const ctx = await newCompany('Twins Co');
    const file = upload('gl.csv', glCsv(fx));
    const r = await runGlImport(ctx, { file });
    expect(r.ok).toBe(true);
    expect(r.counts.entriesPosted).toBe(3);
    expect(new Set((await db.select({ s: journalEntries.sourceRef }).from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'qbgl:%')))).map((x) => x.s)).size)
      .toBe(4); // 3 checks + opening
    const again = await runGlImport(ctx, { file: upload('gl.xlsx', glXlsx(fx)) });
    expect(again.ok).toBe(true);
    expect(again.counts.entriesPosted).toBe(0);
    expect(again.counts.entriesAlreadyImported).toBe(3);
    expect((await balancesByCode(ctx)).get('1000')).toBe('350.00');
  });

  it('re-importing an edited report (one amount changed) does not double-post: it refuses and saves nothing', async () => {
    const ctx = await newCompany('Edited Co');
    expect((await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)) })).ok).toBe(true);
    const before = await counts(ctx);
    const balBefore = await balancesByCode(ctx);
    const edited: GlFixture = {
      ...SAMPLE_GL,
      txns: SAMPLE_GL.txns.map((t) =>
        t.num === 'GJ-1'
          ? { ...t, lines: [{ ...t.lines[0], amount: '650.00' }, { ...t.lines[1], amount: '-650.00' }] }
          : t,
      ),
    };
    const r = await runGlImport(ctx, { file: upload('gl.csv', glCsv(edited)) });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(await counts(ctx)).toEqual(before);
    expect(await balancesByCode(ctx)).toEqual(balBefore);
  });

  it('a voided imported entry is restored by re-importing, and the books reconcile again', async () => {
    const ctx = await newCompany('Void Co');
    expect((await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)) })).ok).toBe(true);
    const balBefore = await balancesByCode(ctx);
    const [gj] = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.reference, 'GJ-1')));
    await voidJournalEntry(ctx, gj.id);
    const r = await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)) });
    expect(r.ok).toBe(true);
    expect(r.counts.entriesPosted).toBe(1);
    expect(r.proof.allMatch).toBe(true);
    expect(await balancesByCode(ctx)).toEqual(balBefore);
    await assertLedgerInvariants(ctx);
  });

  it('pennies + 3-level sub-accounts reconcile exactly from CSV, xlsx (float-noise numbers) and PDF', async () => {
    const end = fxEnding(CENTS_GL);
    // xlsx whose numeric cells carry binary-float noise, as Excel writes after arithmetic.
    const zip = new AdmZip(glXlsx(CENTS_GL));
    const sheet = zip.getEntry('xl/worksheets/sheet2.xml')!;
    const noisy = sheet
      .getData()
      .toString('utf8')
      .replace(/<c r="([A-Z]+\d+)" s="2"><v>(-?\d+\.\d+)<\/v>/g, (_m, ref, v) =>
        `<c r="${ref}" s="2"><v>${(Number(v) + (Number(v) >= 0 ? 1e-11 : -1e-11)).toPrecision(17)}</v>`,
      );
    expect(noisy).not.toBe(sheet.getData().toString('utf8'));
    zip.updateFile('xl/worksheets/sheet2.xml', Buffer.from(noisy, 'utf8'));
    const files = [
      upload('gl.csv', glCsv(CENTS_GL)),
      upload('gl.xlsx', zip.toBuffer()),
      upload('gl.pdf', await glPdf(CENTS_GL, {}, 12)),
    ];
    for (const file of files) {
      const ctx = await newCompany(`Pennies ${file.name}`);
      const r = await runGlImport(ctx, { file, references: [upload('tb.csv', trialBalanceCsv(CENTS_GL))] });
      expect([file.name, r.ok, r.message]).toEqual([file.name, true, r.message]);
      expect(r.review).toEqual([]);
      expect(r.proof.trialBalanceMatches).toBe(true);
      const bal = await balancesByCode(ctx);
      for (const [num, e] of end) expect([file.name, num, bal.get(num) ?? '0.00']).toEqual([file.name, num, e.toFixed(2)]);
      const accts = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
      const by = (c: string) => accts.find((a) => a.code === c)!;
      expect(by('6011').parentId).toBe(by('6010').id);
      expect(by('6010').parentId).toBe(by('6000').id);
      expect(by('6011').name).toBe('Paper');
      const cls = await db.select().from(classes).where(eq(classes.companyId, ctx.companyId));
      expect(cls.find((c) => c.name === 'Metro')!.parentId).toBe(cls.find((c) => c.name === 'North')!.id);
      await assertLedgerInvariants(ctx);
    }
  });

  it('import into two companies is isolated (sourceRefs are per-company)', async () => {
    const a = await newCompany('Iso A');
    const b = await newCompany('Iso B');
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    expect((await runGlImport(a, { file })).counts.entriesPosted).toBe(SAMPLE_GL.txns.length);
    const rb = await runGlImport(b, { file });
    expect(rb.counts.entriesPosted).toBe(SAMPLE_GL.txns.length);
    expect(rb.counts.entriesAlreadyImported).toBe(0);
    expect(await balancesByCode(a)).toEqual(await balancesByCode(b));
  });

  it('re-import after an accepted variance is a no-op and still reconciles', async () => {
    const ctx = await newCompany('Variance Again Co');
    const idx = SAMPLE_GL.txns.findIndex((t) => t.memo === 'Interest');
    const file = upload('gl.csv', glCsv(SAMPLE_GL, { dropLine: { txn: idx, line: 1 } }));
    const first = await runGlImport(ctx, { file, acceptVariance: true });
    expect(first.ok).toBe(true);
    const before = await counts(ctx);
    const bal = await balancesByCode(ctx);
    for (const accept of [false, true]) {
      const r = await runGlImport(ctx, { file, acceptVariance: accept });
      expect(r.ok).toBe(true);
      expect(r.variancePosted).toBeNull();
      expect(r.counts.entriesPosted).toBe(0);
    }
    expect((await counts(ctx)).entries).toBe(before.entries);
    expect(await balancesByCode(ctx)).toEqual(bal);
    expect(bal.get(QB_SUSPENSE.code)).toBe('-12.34');
    await assertLedgerInvariants(ctx);
  });

  it('a period end before the last transaction is refused (not silently cut off)', async () => {
    const ctx = await newCompany('Cutoff Co');
    await expect(
      runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)), periodEnd: '2024-02-29' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await counts(ctx)).entries).toBe(0);
  });

  it('malformed uploads fail as VALIDATION (HTTP 400), never as an internal error', async () => {
    const ctx = await newCompany('Malformed Co');
    const bad: Array<[string, Uint8Array | string]> = [
      ['corrupt.xlsx', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 7)])],
      ['corrupt.pdf', '%PDF-1.4\nthis is not really a pdf\n%%EOF'],
      ['old.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])],
      ['header-only.csv', 'Type,Date,Num,Name,Memo,Split,Debit,Credit,Balance\n'],
      ['empty-ish.csv', '\n\n\n'],
      ['lists.iif', '!ACCNT\tNAME\tACCNTTYPE\nACCNT\tChecking\tBANK\n'],
      ['binary.csv', Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256))],
    ];
    for (const [name, bytes] of bad) {
      let err: unknown = null;
      try {
        await runGlImport(ctx, { file: upload(name, bytes) });
      } catch (e) {
        err = e;
      }
      expect([name, err instanceof ServiceError ? (err as ServiceError).code : String(err)]).toEqual([name, 'VALIDATION']);
    }
    // A junk reference file must not crash the import of a good GL either.
    let refErr: unknown = null;
    try {
      const r = await runGlImport(ctx, {
        file: upload('gl.csv', glCsv(SAMPLE_GL)),
        references: [upload('junk.pdf', '%PDF-1.4 junk')],
      }, { dryRun: true });
      expect(r.dryRun).toBe(true);
    } catch (e) {
      refErr = e;
    }
    if (refErr) expect(refErr instanceof ServiceError && (refErr as ServiceError).code).toBe('VALIDATION');
    await expect(runGlImport(ctx, { file: { name: 'x.csv', data: '' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await counts(ctx)).entries).toBe(0);
  });

  it('a Split that contradicts how lines would be paired is sent to review, not silently forced into one entry', async () => {
    // Checking's line says its other side is Rent; Supplies' line says its other side is Savings.
    // Neither Rent nor Savings has a matching line, so these two lines are NOT one transaction —
    // even though they happen to offset each other (-100 / +100) on the same date and type.
    const fx: GlFixture = {
      company: 'Contradiction Co',
      periodLabel: 'January 1 through January 31, 2024',
      accounts: [
        { number: '1000', name: 'Checking', type: 'Bank', begin: '1000.00' },
        { number: '1010', name: 'Savings', type: 'Bank', begin: '0.00' },
        { number: '3000', name: 'Owner Equity', type: 'Equity', begin: '-1000.00' },
        { number: '6000', name: 'Rent', type: 'Expense', begin: '0.00' },
        { number: '6100', name: 'Supplies', type: 'Expense', begin: '0.00' },
      ],
      txns: [
        { type: 'Check', date: '01/05/2024', name: '', lines: [
          { acct: '1000', amount: '-100.00', name: 'Landlord' },
          { acct: '6100', amount: '100.00', name: 'Staples' },
        ] },
      ],
    };
    const csv = csvWithSplit(fx, [
      { match: (r) => r.includes('Landlord'), split: '6000 · Rent' },
      { match: (r) => r.includes('Staples'), split: '1010 · Savings' },
    ]);
    const ctx = await newCompany('Contradiction Co');
    const file = upload('gl.csv', csv);
    const preview = await previewGlImport(ctx, { file });
    expect(preview.review.length).toBeGreaterThan(0);
    const r = await runGlImport(ctx, { file });
    expect(r.counts.entriesPosted).toBe(0);
  });

  it('accepting a variance never commits a Trial Balance mismatch as a clean success', async () => {
    const ctx = await newCompany('TB Accept Co');
    const r = await runGlImport(ctx, {
      file: upload('gl.csv', glCsv(SAMPLE_GL)),
      references: [upload('tb.csv', trialBalanceCsv(SAMPLE_GL, { acct: '64000', by: '1.00' }))],
      acceptVariance: true,
    });
    // The user accepted "posting the variance to QB Import Suspense". If the import commits,
    // the TB difference must actually have been dealt with (posted) or at least be flagged —
    // not committed with nothing posted and a message saying every account matches.
    if (r.ok) {
      const flagged =
        r.variancePosted !== null ||
        r.proof.trialBalanceMatches ||
        /trial balance/i.test(r.message) ||
        r.warnings.some((w) => /trial balance/i.test(w));
      expect(flagged).toBe(true);
    }
  });

  // ---- re-test round 1: verify the Split-contradiction and Trial Balance fixes ----

  const CONTRA_ACCOUNTS: GlFixture['accounts'] = [
    { number: '1000', name: 'Checking', type: 'Bank', begin: '1000.00' },
    { number: '1010', name: 'Savings', type: 'Bank', begin: '0.00' },
    { number: '3000', name: 'Owner Equity', type: 'Equity', begin: '-1000.00' },
    { number: '6000', name: 'Rent', type: 'Expense', begin: '0.00' },
    { number: '6100', name: 'Supplies', type: 'Expense', begin: '0.00' },
    { number: '6200', name: 'Utilities', type: 'Expense', begin: '0.00' },
  ];

  it('round1: contradicted Split lines go to review in full; the import refuses (or suspends) and never posts them as an entry', async () => {
    const fx: GlFixture = {
      company: 'Contra Run Co',
      periodLabel: 'January 1 through January 31, 2024',
      accounts: CONTRA_ACCOUNTS,
      txns: [
        { type: 'Check', date: '01/05/2024', name: '', lines: [
          { acct: '1000', amount: '-100.00', name: 'Landlord' },
          { acct: '6100', amount: '100.00', name: 'Staples' },
        ] },
        // A clean transaction in the same file still posts.
        { type: 'Check', date: '01/09/2024', num: '501', name: 'Power Co', lines: [
          { acct: '1000', amount: '-40.00' },
          { acct: '6200', amount: '40.00' },
        ] },
      ],
    };
    const csv = csvWithSplit(fx, [
      { match: (r) => r.includes('Landlord'), split: '6000 · Rent' },
      { match: (r) => r.includes('Staples'), split: '1010 · Savings' },
    ]);
    const file = upload('gl.csv', csv);
    const a = analyzeGl(parseGlSheets((await loadGrid(new TextEncoder().encode(csv), 'gl.csv')).sheets));
    expect(a.transactions.length).toBe(1);
    expect(a.review.length).toBe(1);
    expect(a.review[0].lines.length).toBe(2);
    expect(a.review[0].reason).toMatch(/Split/);
    // Without acceptance: nothing saved at all.
    const ctx = await newCompany('Contra Run Co');
    const r = await runGlImport(ctx, { file });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(await counts(ctx)).toEqual({ entries: 0, accounts: 0, classes: 0, customers: 0, vendors: 0, imports: 0 });
    // With acceptance: the difference sits in suspense, not in a fabricated Checking/Supplies entry.
    const ok = await runGlImport(ctx, { file, acceptVariance: true });
    expect(ok.ok).toBe(true);
    expect(ok.variancePosted).not.toBeNull();
    expect(ok.counts.entriesPosted).toBe(1); // only check 501
    const bal = await balancesByCode(ctx);
    expect(bal.get('6100') ?? '0.00').toBe('100.00'); // ending matches the report via suspense
    expect(bal.get('1000')).toBe('860.00');
    const suppliesLines = await db
      .select({ src: journalEntries.sourceRef })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(accounts.code, '6100')));
    // The only posting into Supplies is the reviewed variance, not a rebuilt Check.
    expect(suppliesLines.length).toBe(1);
    await assertLedgerInvariants(ctx);
  });

  it('round1: per-payee balanced lines whose Splits point elsewhere are not posted per payee either', async () => {
    const fx: GlFixture = {
      company: 'Contra Payee Co',
      periodLabel: 'January 1 through January 31, 2024',
      accounts: CONTRA_ACCOUNTS,
      txns: [
        { type: 'Check', date: '01/05/2024', name: '', lines: [
          { acct: '1000', amount: '-100.00', name: 'Landlord', memo: 'mA' },
          { acct: '6100', amount: '100.00', name: 'Landlord', memo: 'mB' },
          { acct: '1010', amount: '-30.00', name: 'Staples', memo: 'mC' },
          { acct: '6200', amount: '30.00', name: 'Staples', memo: 'mD' },
        ] },
      ],
    };
    const csv = csvWithSplit(fx, [
      { match: (r) => r.includes('mA') || r.includes('mB'), split: '6000 · Rent' },
      { match: (r) => r.includes('mC') || r.includes('mD'), split: '3000 · Owner Equity' },
    ]);
    const a = analyzeGl(parseGlSheets((await loadGrid(new TextEncoder().encode(csv), 'gl.csv')).sheets));
    expect(a.transactions.length).toBe(0);
    expect(a.review.reduce((n, x) => n + x.lines.length, 0)).toBe(4);
  });

  it('round1: no false positives - leftover lines whose Splits agree (or are blank/unknown) still post', async () => {
    // Checking -100 says Rent; Rent +60 and +40 both say Checking. Pairs fail (amounts differ), but
    // the Split column fully agrees with the grouping, so it is one balanced entry.
    const fx: GlFixture = {
      company: 'Agree Co',
      periodLabel: 'January 1 through January 31, 2024',
      accounts: CONTRA_ACCOUNTS,
      txns: [
        { type: 'Check', date: '01/05/2024', num: '77', name: 'Landlord', lines: [
          { acct: '1000', amount: '-100.00', memo: 'x1' },
          { acct: '6000', amount: '60.00', memo: 'x2' },
          { acct: '6000', amount: '40.00', memo: 'x3' },
        ] },
        { type: 'Check', date: '01/06/2024', num: '78', name: 'Staples', lines: [
          { acct: '1000', amount: '-25.00', memo: 'y1' },
          { acct: '6100', amount: '25.00', memo: 'y2' },
        ] },
        { type: 'Check', date: '01/07/2024', num: '79', name: 'Power Co', lines: [
          { acct: '1000', amount: '-15.00', memo: 'z1' },
          { acct: '6200', amount: '15.00', memo: 'z2' },
        ] },
      ],
    };
    const csv = csvWithSplit(fx, [
      { match: (r) => r.includes('x1'), split: '6000 · Rent' },
      { match: (r) => r.includes('x2') || r.includes('x3'), split: '1000 · Checking' },
      { match: (r) => r.includes('y1') || r.includes('y2'), split: '' },
      { match: (r) => r.includes('z1'), split: '9999 · Not In This Report' },
      { match: (r) => r.includes('z2'), split: 'Some Unknown Account' },
    ]);
    const file = upload('gl.csv', csv);
    const a = analyzeGl(parseGlSheets((await loadGrid(new TextEncoder().encode(csv), 'gl.csv')).sheets));
    expect(a.review).toEqual([]);
    expect(a.transactions.length).toBe(3);
    const ctx = await newCompany('Agree Co');
    const r = await runGlImport(ctx, { file });
    expect([r.ok, r.message]).toEqual([true, r.message]);
    expect(r.proof.allMatch).toBe(true);
    await assertLedgerInvariants(ctx);
  });

  it('round1: a Trial Balance mismatch with acceptVariance rolls back everything (no suspense, names or import record)', async () => {
    const ctx = await newCompany('TB Strict Co');
    const badTb = () => [upload('tb.csv', trialBalanceCsv(SAMPLE_GL, { acct: '64000', by: '1.00' }))];
    const r = await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)), references: badTb(), acceptVariance: true });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.variancePosted).toBeNull();
    expect(r.proof.trialBalanceMatches).toBe(false);
    expect(r.message).toMatch(/Trial Balance/);
    expect(r.message).not.toMatch(/Every account matches the QuickBooks report/);
    expect(await counts(ctx)).toEqual({ entries: 0, accounts: 0, classes: 0, customers: 0, vendors: 0, imports: 0 });
    // Without acceptance, and as a dry run, the result is the same refusal.
    const plain = await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)), references: badTb() });
    expect(plain.ok).toBe(false);
    const dry = await runGlImport(
      ctx,
      { file: upload('gl.csv', glCsv(SAMPLE_GL)), references: badTb(), acceptVariance: true },
      { dryRun: true },
    );
    expect(dry.ok).toBe(false);
    expect(dry.proof.trialBalanceMatches).toBe(false);
    expect(await counts(ctx)).toEqual({ entries: 0, accounts: 0, classes: 0, customers: 0, vendors: 0, imports: 0 });
    // And the same GL with a correct TB imports cleanly.
    const good = await runGlImport(ctx, {
      file: upload('gl.csv', glCsv(SAMPLE_GL)),
      references: [upload('tb.csv', trialBalanceCsv(SAMPLE_GL))],
    });
    expect(good.ok).toBe(true);
    expect(good.proof.trialBalanceMatches).toBe(true);
    await assertLedgerInvariants(ctx);
  });

  it('round1: GL variance accepted + a TB that disagrees -> still rolled back; no suspense account left behind', async () => {
    const ctx = await newCompany('TB Both Co');
    const idx = SAMPLE_GL.txns.findIndex((t) => t.memo === 'Interest');
    const r = await runGlImport(ctx, {
      file: upload('gl.csv', glCsv(SAMPLE_GL, { dropLine: { txn: idx, line: 1 } })),
      references: [upload('tb.csv', trialBalanceCsv(SAMPLE_GL, { acct: '64000', by: '1.00' }))],
      acceptVariance: true,
    });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.variancePosted).toBeNull();
    expect(await counts(ctx)).toEqual({ entries: 0, accounts: 0, classes: 0, customers: 0, vendors: 0, imports: 0 });
    const susp = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, QB_SUSPENSE.code)));
    expect(susp).toEqual([]);
  });

  it('round1: pre-existing non-imported postings in a mapped account are reported in a warning', async () => {
    const ctx = await newCompany('Drift Co');
    const rent = await createAccount(ctx, { code: '62000', name: 'Rent Expense', type: 'expense', subtype: 'operating_expenses' });
    const petty = await createAccount(ctx, { code: '19999', name: 'Petty Cash', type: 'asset', subtype: 'checking' });
    await postJournalEntry(ctx, {
      date: new Date('2024-02-10T00:00:00Z'),
      description: 'manual rent before migration',
      lines: [
        { accountId: rent.id, debit: '50.00' },
        { accountId: petty.id, credit: '50.00' },
      ],
    });
    const file = upload('gl.csv', glCsv(SAMPLE_GL));
    const preview = await previewGlImport(ctx, { file });
    const key = preview.accounts.find((a) => a.number === '62000')!.key;
    const r = await runGlImport(ctx, { file, accounts: { [key]: { mapTo: rent.id } } });
    expect([r.ok, r.message]).toEqual([true, r.message]);
    expect(r.proof.allMatch).toBe(true);
    expect(r.warnings.some((w) => /weren't part of this import/.test(w) && w.includes('62000'))).toBe(true);
    await assertLedgerInvariants(ctx);
  });
});

describe('qbGl parsers — adversarial', () => {
  it('amount parsing rejects garbage and keeps pennies exact', () => {
    expect(parseAmount('1.2.3')).toBeNull();
    expect(parseAmount('12abc')).toBeNull();
    expect(parseAmount('--5')).toBeNull();
    expect(parseAmount('()')).toBeNull();
    expect(parseAmount('$(1,234.56)')?.toFixed(2)).toBe('-1234.56');
    expect(parseAmount(' (0.01) ')?.toFixed(2)).toBe('-0.01');
    expect(parseAmount('0.30000000000000004')?.toFixed(2)).toBe('0.30');
    expect(parseAmount('1234.5650000000001')?.toFixed(2)).toBe('1234.57');
    expect(parseAmount('-0.004')?.toFixed(2)).toBe('0.00');
    expect(parseAmount('1,000,000.00')?.toFixed(2)).toBe('1000000.00');
  });

  it('date parsing rejects impossible dates', () => {
    expect(parseQbDate('02/29/2023')).toBeNull();
    expect(parseQbDate('13/01/2024')).toBeNull();
    expect(parseQbDate('00/10/2024')).toBeNull();
    expect(parseQbDate('02/29/2024')).toBe('2024-02-29');
    expect(parseQbDate('12/31/99')).toBe('1999-12-31');
  });

  it('xlsx helpers: column letters and serials', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('AZ')).toBe(51);
    expect(columnIndex('XFD')).toBe(16383);
    expect(excelSerialToDate(45292)).toBe('01/01/2024');
    expect(excelSerialToDate(45351)).toBe('02/29/2024');
    expect(excelSerialToDate(45292.75)).toBe('01/01/2024');
    expect(excelSerialToDate(43830, true)).toBe('01/01/2024');
  });

  it('reads a single-sheet workbook with a single relationship (XML one-element lists)', async () => {
    const zip = new AdmZip(glXlsx(SAMPLE_GL));
    zip.updateFile(
      'xl/workbook.xml',
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="GL" sheetId="1" r:id="rId2"/></sheets></workbook>',
      ),
    );
    zip.updateFile(
      'xl/_rels/workbook.xml.rels',
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      ),
    );
    const sheets = readXlsx(new Uint8Array(zip.toBuffer()));
    expect(sheets.map((s) => s.name)).toEqual(['GL']);
    const a = analyzeGl(parseGlSheets(sheets));
    expect(a.errors).toEqual([]);
    expect(a.transactions).toHaveLength(SAMPLE_GL.txns.length);
  });

  it('CSV with BOM + CRLF line endings parses identically to plain CSV', async () => {
    const plain = glCsv(SAMPLE_GL);
    const bom = '﻿' + plain.replace(/\r?\n/g, '\r\n');
    const load = async (s: string) => {
      const g = await loadGrid(new TextEncoder().encode(s), 'gl.csv');
      return analyzeGl(parseGlSheets(g.sheets));
    };
    const [x, y] = [await load(plain), await load(bom)];
    expect(y.errors).toEqual([]);
    expect(y.transactions.map((t) => t.ref).sort()).toEqual(x.transactions.map((t) => t.ref).sort());
  });

  it('every rebuilt transaction balances to the penny (SAMPLE_GL, all formats)', async () => {
    for (const [name, bytes] of [
      ['gl.csv', new TextEncoder().encode(glCsv(SAMPLE_GL))],
      ['gl.xlsx', new Uint8Array(glXlsx(SAMPLE_GL))],
      ['gl.pdf', await glPdf(SAMPLE_GL)],
    ] as const) {
      const g = await loadGrid(bytes, name);
      const a = analyzeGl(parseGlSheets(g.sheets));
      for (const t of a.transactions) {
        const dr = t.lines.reduce((s, l) => s.plus(l.debit), Money.zero());
        const cr = t.lines.reduce((s, l) => s.plus(l.credit), Money.zero());
        expect([name, t.ref, dr.toFixed(2)]).toEqual([name, t.ref, cr.toFixed(2)]);
        expect(t.lines.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
