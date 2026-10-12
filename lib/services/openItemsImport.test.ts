/**
 * L6 — open A/R and A/P conversion. A General Ledger import (simulated with qbgl:* journal
 * entries) already holds the A/R and A/P balances; bringing the open invoices / bills in as
 * documents must NOT double count: afterwards A/R control == A/R aging and A/P control ==
 * A/P aging, the conversion clearing account is zero, and the trial balance balances.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, creditMemos, customers, invoices, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { importIIF } from './qbImport';
import {
  QB_CONVERSION_CLEARING,
  arApReconciliation,
  importOpenItems,
  parseOpenItemsGrid,
  previewOpenItems,
} from './openItemsImport';
import { readCsv } from './qbGlFiles';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-open-items-w2');
let db: DB;
let ctx: ServiceContext;

const OPEN_INVOICES_CSV = [
  '"Acme Test Co"',
  '"Open Invoices"',
  '"As of December 31, 2025"',
  ',,Type,Date,Num,Terms,Due Date,Aging,Open Balance',
  'Acme,,,,,,,,',
  ',,Invoice,11/15/2025,1001,Net 30,12/15/2025,16,"1,000.00"',
  ',,Invoice,12/01/2025,1002,Net 30,12/31/2025,,700.00',
  ',,Credit Memo,12/10/2025,CM-1,,,,-200.00',
  'Total Acme,,,,,,,,"1,500.00"',
  'Beta LLC,,,,,,,,',
  ',Job A,,,,,,,',
  ',,Invoice,12/20/2025,1003,Net 15,01/04/2026,,300.00',
  ',Total Job A,,,,,,,300.00',
  'Total Beta LLC,,,,,,,,300.00',
  'TOTAL,,,,,,,,"1,800.00"',
].join('\r\n');

const UNPAID_BILLS_CSV = [
  '"Unpaid Bills Detail"',
  '"As of December 31, 2025"',
  ',Type,Date,Num,Due Date,Aging,Open Balance',
  'Supply Co,,,,,,',
  ',Bill,12/05/2025,B-77,01/04/2026,,900.00',
  ',Credit,12/20/2025,,,,-100.00',
  'Total Supply Co,,,,,,800.00',
  'TOTAL,,,,,,800.00',
].join('\r\n');

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

async function accountId(code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return a.id;
}

describe('open A/R and A/P conversion', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'openitems@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Open Items Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };

    // What a General Ledger import leaves behind: A/R 1,800 and A/P 800 with no documents.
    const ar = await accountId('1200');
    const ap = await accountId('2000');
    const equity = await accountId('3000');
    await postJournalEntry(ctx, {
      date: new Date('2025-12-31T00:00:00Z'),
      description: 'QuickBooks opening balances',
      sourceRef: 'qbgl:open:2025-12-31:test',
      lines: [
        { accountId: ar, debit: '1800.00' },
        { accountId: equity, credit: '1000.00' },
        { accountId: ap, credit: '800.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('parses customer / job groups, credits and totals from the report grid', () => {
    const parsed = parseOpenItemsGrid(readCsv(OPEN_INVOICES_CSV));
    expect(parsed.side).toBe('ar');
    expect(parsed.items.map((i) => [i.kind, i.name, i.number, i.openBalance])).toEqual([
      ['invoice', 'Acme', '1001', '1000.00'],
      ['invoice', 'Acme', '1002', '700.00'],
      ['credit_memo', 'Acme', 'CM-1', '200.00'],
      ['invoice', 'Beta LLC:Job A', '1003', '300.00'],
    ]);
    expect(parsed.items[0].dueDate).toBe('2025-12-15');
    const ap = parseOpenItemsGrid(readCsv(UNPAID_BILLS_CSV));
    expect(ap.side).toBe('ap');
    expect(ap.items.map((i) => [i.kind, i.openBalance])).toEqual([['bill', '900.00'], ['vendor_credit', '100.00']]);
  });

  it('before conversion the control accounts have no document detail', async () => {
    const rec = await arApReconciliation(ctx);
    expect(rec.ar.control).toBe('1800.00');
    expect(rec.ar.aging).toBe('0.00');
    expect(rec.ar.inBalance).toBe(false);
  });

  it('previews without writing anything', async () => {
    const p = await previewOpenItems(ctx, { file: { name: 'open-invoices.csv', data: b64(OPEN_INVOICES_CSV) } });
    expect(p.side).toBe('ar');
    expect(p.totals.documents).toBe('2000.00');
    expect(p.totals.credits).toBe('200.00');
    expect(p.totals.net).toBe('1800.00');
    expect(p.missingNames).toEqual(['Acme', 'Beta LLC:Job A']);
    expect(p.controlAccount?.code).toBe('1200');
    expect(p.alreadyInGlSuggested).toBe(true);
    const inv = await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
    expect(inv).toHaveLength(0);
  });

  it('A/R: creates real invoices and credits; A/R control still equals the GL import AND the aging', async () => {
    const r = await importOpenItems(ctx, { file: { name: 'open-invoices.csv', data: b64(OPEN_INVOICES_CSV) }, alreadyInGl: true });
    expect(r.invoices).toBe(3);
    expect(r.credits).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.reconciliation.ar.control).toBe('1800.00'); // unchanged — nothing double counted
    expect(r.reconciliation.ar.aging).toBe('1800.00');
    expect(r.reconciliation.ar.inBalance).toBe(true);

    const [clearing] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, QB_CONVERSION_CLEARING.code)));
    expect(Number(clearing.balance)).toBe(0);
    expect((await trialBalance(ctx)).balanced).toBe(true);

    // Real, payable documents with due dates; jobs land under their parent customer.
    const inv = await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
    const i1001 = inv.find((i) => i.memo?.includes('#1001'))!;
    expect(i1001.balanceDue).toBe('1000.00');
    expect(i1001.status).toBe('open');
    expect(i1001.dueDate?.toISOString().slice(0, 10)).toBe('2025-12-15');
    const custs = await ctx.db.select().from(customers).where(eq(customers.companyId, ctx.companyId));
    const beta = custs.find((c) => c.displayName === 'Beta LLC')!;
    expect(custs.find((c) => c.displayName === 'Beta LLC:Job A')?.parentId).toBe(beta.id);
    const cms = await ctx.db.select().from(creditMemos).where(eq(creditMemos.companyId, ctx.companyId));
    expect(cms).toHaveLength(1);
  });

  it('re-importing the same report is a no-op', async () => {
    const r = await importOpenItems(ctx, { file: { name: 'open-invoices.csv', data: b64(OPEN_INVOICES_CSV) }, alreadyInGl: true });
    expect(r.invoices + r.credits).toBe(0);
    expect(r.skipped).toBe(4);
    expect(r.reconciliation.ar.inBalance).toBe(true);
    expect(r.reconciliation.ar.control).toBe('1800.00');
  });

  it('A/P: unpaid bills and vendor credits; A/P control equals the aging', async () => {
    const r = await importOpenItems(ctx, { file: { name: 'unpaid-bills.csv', data: b64(UNPAID_BILLS_CSV) }, alreadyInGl: true });
    expect(r.bills).toBe(1);
    expect(r.credits).toBe(1);
    expect(r.reconciliation.ap.control).toBe('800.00');
    expect(r.reconciliation.ap.aging).toBe('800.00');
    expect(r.reconciliation.ap.inBalance).toBe(true);
    const [bill] = await ctx.db.select().from(bills).where(eq(bills.companyId, ctx.companyId));
    expect(bill.billNumber).toBe('B-77');
    expect(bill.balanceDue).toBe('900.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('refuses items that the General Ledger does not hold (would double count)', async () => {
    await expect(
      importOpenItems(ctx, {
        side: 'ar',
        alreadyInGl: true,
        items: [{ kind: 'invoice', name: 'Overflow Co', date: '2025-12-31', openBalance: '100.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const inv = await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
    expect(inv.some((i) => i.memo?.includes('Overflow'))).toBe(false);
    expect((await arApReconciliation(ctx)).ar.inBalance).toBe(true);
  });

  it('typed-in opening balance for a fresh start goes against Opening Balance Equity and keeps A/R = aging', async () => {
    const r = await importOpenItems(ctx, {
      side: 'ar',
      alreadyInGl: false,
      items: [{ kind: 'invoice', name: 'Fresh Co', date: '2025-12-31', openBalance: '250.00' }],
    });
    expect(r.invoices).toBe(1);
    expect(r.reconciliation.ar.control).toBe('2050.00');
    expect(r.reconciliation.ar.inBalance).toBe(true);
    const [obe] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Opening Balance Equity')));
    expect(obe).toBeTruthy();
  });

  it('IIF INVOICE / BILL transactions become documents; paid ones are left out', async () => {
    const t = (...c: string[]) => c.join('\t');
    const iif = [
      t('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'DUEDATE', 'PAID'),
      t('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'INVITEM', 'QNTY', 'PRICE'),
      t('!ENDTRNS'),
      t('TRNS', '', 'INVOICE', '12/15/2025', 'Accounts Receivable', 'Zed Co', '400.00', '2001', 'Design work', '1/14/2026', 'N'),
      t('SPL', '', 'INVOICE', '12/15/2025', 'Sales Income', '', '-400.00', '2001', 'Design', 'Design', '-4', '100'),
      t('ENDTRNS'),
      t('TRNS', '', 'INVOICE', '12/16/2025', 'Accounts Receivable', 'Zed Co', '90.00', '2002', '', '', 'Y'),
      t('SPL', '', 'INVOICE', '12/16/2025', 'Sales Income', '', '-90.00', '2002', '', '', '', ''),
      t('ENDTRNS'),
      t('TRNS', '', 'BILL', '12/18/2025', 'Accounts Payable', 'Paper Inc', '-60.00', 'P-9', '', '1/17/2026', 'N'),
      t('SPL', '', 'BILL', '12/18/2025', 'Office Supplies', '', '60.00', 'P-9', '', '', '', ''),
      t('ENDTRNS'),
    ].join('\r\n');
    const counts = await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    expect(counts.openItems).toMatchObject({ invoices: 1, bills: 1 });
    expect(counts.transactions).toBe(0); // not posted twice as journal entries
    expect(counts.issues.some((i) => /Marked paid/.test(i.message))).toBe(true);
    const rec = await arApReconciliation(ctx);
    expect(rec.ar.inBalance).toBe(true);
    expect(rec.ap.inBalance).toBe(true);
    expect(rec.ar.control).toBe('2450.00');
    expect(rec.ap.control).toBe('860.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
