/**
 * Review 13 — QuickBooks Desktop conversion, end to end (lists IIF, then General Ledger).
 *
 *  1. QuickBooks' File > Export > Lists to IIF writes each balance-sheet account's CURRENT balance
 *     into ACCNT OBAMOUNT. Posting those as opening balances and then importing the General
 *     Ledger doubled the balance sheet. A list-only IIF now posts no OBAMOUNT unless the user
 *     opts in (refused after a GL import), and every OBAMOUNT left out is reported.
 *  2. The GL import's after-check only looked at entries dated up to the GL period end, so the
 *     IIF opening balances (dated the import day) were missed and the result said every account
 *     matched. Non-GL entries in the accounts the GL posts to (any date) now block the import
 *     until the user confirms, and are listed by source.
 *  3. IIF INVITEMTYPE: QuickBooks writes PART for a NON-inventory part and INVENTORY for an
 *     inventory part. PART is read as non-inventory (unless the row carries stock data, as older
 *     Ironbooks exports did) and inventory is exported as INVENTORY.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, items, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createCompany, NEW_COMPANY_SETTINGS } from './company';
import { importIIF, mapIifItemType } from './qbImport';
import { exportListsIif, qbItemType } from './iifExport';
import { previewGlImport, runGlImport } from './qbGlImport';
import { SAMPLE_GL, fxEnding, glCsv, upload } from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review13-conversion');
let db: DB;
let userId: string;

async function newCo(name: string): Promise<ServiceContext> {
  const co = await createCompany(db, { name, ownerId: userId, settings: { ...NEW_COMPANY_SETTINGS } });
  return { db, companyId: co.id, userId };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'review13@test.local', name: 'R13', passwordHash: 'x' }).returning();
  userId = u.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

const TYPE_MAP: Record<string, string> = {
  Bank: 'BANK', 'Accounts Receivable': 'AR', 'Other Current Asset': 'OCASSET', 'Fixed Asset': 'FIXASSET',
  'Accounts Payable': 'AP', 'Credit Card': 'CCARD', 'Other Current Liability': 'OCLIAB', Equity: 'EQUITY',
  Income: 'INC', 'Cost of Goods Sold': 'COGS', Expense: 'EXP', 'Other Income': 'EXINC',
};
const BS = new Set(['BANK', 'AR', 'OCASSET', 'FIXASSET', 'AP', 'CCARD', 'OCLIAB', 'EQUITY']);

/** What QuickBooks' "Export Lists to IIF" writes for SAMPLE_GL: OBAMOUNT = current balance. */
function qbListExport(extra: string[] = []): { iif: string; obRows: number } {
  const end = fxEnding(SAMPLE_GL);
  const byNum = new Map(SAMPLE_GL.accounts.map((a) => [a.number, a]));
  const full = (a: (typeof SAMPLE_GL.accounts)[number]): string => (a.parent ? `${full(byNum.get(a.parent)!)}:${a.name}` : a.name);
  let obRows = 0;
  const rows = SAMPLE_GL.accounts.map((a, i) => {
    const t = TYPE_MAP[a.type];
    const ob = BS.has(t) ? end.get(a.number)!.toFixed(2) : '0.00';
    if (!Money.of(ob).isZero()) obRows++;
    return `ACCNT\t${full(a)}\t${i + 1}\t1700000000\t${t}\t${ob}\t\t${a.number}\t0\t\t\tN\t0\tN`;
  });
  const iif = [
    '!ACCNT\tNAME\tREFNUM\tTIMESTAMP\tACCNTTYPE\tOBAMOUNT\tDESC\tACCNUM\tSCD\tBANKNUM\tEXTRA\tHIDDEN\tDELCOUNT\tUSEID',
    ...rows,
    '!CUST\tNAME\tREFNUM\tTIMESTAMP\tBADDR1\tTAXABLE\tHIDDEN',
    'CUST\tAcme Corp\t1\t1\tAcme Corp\tY\tN',
    '!VEND\tNAME\tREFNUM\tTIMESTAMP\tADDR1\t1099\tHIDDEN',
    'VEND\tShell Oil\t1\t1\tShell Oil\tN\tN',
    ...extra,
  ].join('\r\n');
  return { iif, obRows };
}

/** Balance (debit-positive) of every account by code, all posted entries. */
async function balances(ctx: ServiceContext): Promise<Map<string, string>> {
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

async function openingEntries(ctx: ServiceContext): Promise<number> {
  const rows = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'account:%')));
  return rows.length;
}

describe('review13 #1 — list-only IIF does not post OBAMOUNT by default', () => {
  it('posts no balances, reports every OBAMOUNT left out, then the GL import matches without doubling', async () => {
    const ctx = await newCo('List Then GL');
    const { iif, obRows } = qbListExport();
    const counts = await importIIF(ctx, iif);
    expect(await openingEntries(ctx)).toBe(0);
    expect((await balances(ctx)).size).toBe(0);
    // One summary note + one note per account whose OBAMOUNT was not posted (new AND matched).
    expect(counts.issues[0]).toMatchObject({ entity: 'list', reason: 'note' });
    expect(counts.issues[0].message).toContain(`${obRows} account balance(s)`);
    const perAccount = counts.issues.filter((i) => i.entity === 'account' && /\(OBAMOUNT\).*not posted/.test(i.message));
    expect(perAccount).toHaveLength(obRows);
    // Accounts matched to the default chart by name are reported too (never dropped silently).
    const dupes = counts.issues.filter((i) => i.entity === 'account' && i.reason === 'duplicate').map((i) => i.name);
    expect(dupes.length).toBeGreaterThan(0);
    for (const name of dupes) {
      const a = SAMPLE_GL.accounts.find((x) => x.name === name);
      if (!a || !BS.has(TYPE_MAP[a.type]) || fxEnding(SAMPLE_GL).get(a.number)!.isZero()) continue;
      expect(perAccount.some((i) => i.name === name)).toBe(true);
    }

    const input = { file: upload('gl.csv', glCsv(SAMPLE_GL)) };
    const pv = await previewGlImport(ctx, input);
    expect(pv.existingEntries).toEqual([]);
    const r = await runGlImport(ctx, input);
    expect([r.ok, r.message]).toEqual([true, r.message]);
    expect(r.existingEntries ?? []).toEqual([]);
    const bal = await balances(ctx);
    const end = fxEnding(SAMPLE_GL);
    // Furniture and Equipment: 12,000 — not 24,000.
    expect(bal.get('15000')).toBe(end.get('15000')!.toFixed(2));
    // No second Opening Balance Equity carrying the IIF balances.
    const obe = await ctx.db
      .select({ code: accounts.code })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Opening Balance Equity')));
    for (const o of obe) if (o.code !== '30000') expect(Money.of(bal.get(o.code) ?? '0').isZero()).toBe(true);
  }, 120_000);

  it('opt-in posts the balances on the chosen date — including accounts matched to the default chart', async () => {
    const ctx = await newCo('Opt In');
    const { iif } = qbListExport();
    const counts = await importIIF(ctx, iif, { postOpeningBalances: true, openingBalanceDate: '2024-03-31' });
    const bal = await balances(ctx);
    const end = fxEnding(SAMPLE_GL);
    expect(bal.get('15000')).toBe(end.get('15000')!.toFixed(2));
    const dated = await ctx.db
      .select({ date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'account:%')));
    expect(dated.length).toBeGreaterThan(0);
    for (const d of dated) expect(d.date.toISOString().slice(0, 10)).toBe('2024-03-31');
    // A/R and A/P can't take an opening balance: each is reported, not dropped.
    expect(counts.issues.some((i) => i.entity === 'account' && i.name === 'Accounts Receivable' && /OBAMOUNT/.test(i.message))).toBe(true);
    // Every matched (pre-existing) account with a balance either got it or has a note.
    const dupes = counts.issues.filter((i) => i.reason === 'duplicate' && i.entity === 'account');
    for (const d of dupes) {
      const a = SAMPLE_GL.accounts.find((x) => x.name === d.name);
      if (!a || !BS.has(TYPE_MAP[a.type]) || end.get(a.number)!.isZero()) continue;
      const posted = bal.get(d.code!) === end.get(a.number)!.toFixed(2);
      const noted = counts.issues.some((i) => i.name === d.name && /OBAMOUNT/.test(i.message));
      expect(posted || noted).toBe(true);
    }
  }, 120_000);

  it('opt-in is refused once a General Ledger import is in the books; the default posts nothing and says why', async () => {
    const ctx = await newCo('GL Then Lists');
    const gl = await runGlImport(ctx, { file: upload('gl.csv', glCsv(SAMPLE_GL)) });
    expect(gl.ok).toBe(true);
    const before = await balances(ctx);
    const { iif } = qbListExport();
    await expect(importIIF(ctx, iif, { postOpeningBalances: true })).rejects.toThrow(ServiceError);
    await expect(importIIF(ctx, iif, { postOpeningBalances: true })).rejects.toThrow(/General Ledger import/);
    const counts = await importIIF(ctx, iif);
    expect(counts.issues[0].message).toMatch(/General Ledger import already holds/);
    expect(await balances(ctx)).toEqual(before);
  }, 120_000);

  it('an inventory account with a QuickBooks balance is carried whether or not that balance is posted', async () => {
    const iifWithStock = (ob: string) =>
      [
        '!ACCNT\tNAME\tACCNTTYPE\tOBAMOUNT\tACCNUM',
        `ACCNT\tStock On Hand\tOCASSET\t${ob}\t13500`,
        '!INVITEM\tNAME\tINVITEMTYPE\tCOST\tASSETACCNT\tQNTY\tVALUE',
        'INVITEM\tWidget\tINVENTORY\t10.00\tStock On Hand\t5\t50.00',
      ].join('\r\n');

    // Not opted in: the balance comes from the General Ledger / Trial Balance import (lists first,
    // then the GL), so the stock is set up without a second inventory entry the GL would double.
    const a = await newCo('Stock Not Posted');
    const ca = await importIIF(a, iifWithStock('50.00'));
    expect(ca.openingStock).toEqual({ items: 1, value: '50.00', unposted: 1 });
    expect((await balances(a)).get('13500') ?? '0.00').toBe('0.00');

    // Opted in: the OBAMOUNT carries the asset balance; the stock comes in without a second entry.
    const b = await newCo('Stock Carried');
    const cb = await importIIF(b, iifWithStock('50.00'), { postOpeningBalances: true });
    expect(cb.openingStock).toEqual({ items: 1, value: '50.00', unposted: 1 });
    expect((await balances(b)).get('13500')).toBe('50.00');
  }, 120_000);
});

describe('review13 #2 — GL import refuses to sit on top of other balances in its accounts', () => {
  it('lists non-GL entries dated after the period, blocks until confirmed, and never claims a clean match', async () => {
    const ctx = await newCo('Doubled');
    const { iif } = qbListExport();
    await importIIF(ctx, iif, { postOpeningBalances: true }); // dated today: long after 03/31/2024
    const input = { file: upload('gl.csv', glCsv(SAMPLE_GL)) };

    const pv = await previewGlImport(ctx, input);
    expect(pv.existingEntries.length).toBeGreaterThan(0);
    expect(pv.warnings.filter((w) => /count them twice/.test(w))).toEqual([expect.stringMatching(/account opening balance/)]);

    const dry = await runGlImport(ctx, input, { dryRun: true });
    expect(dry.ok).toBe(false);
    const r = await runGlImport(ctx, input);
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.message).toMatch(/Nothing was saved/);
    expect(r.message).toMatch(/counted twice/);
    const furniture = r.existingEntries!.find((e) => e.code === '15000')!;
    expect(furniture.sources.map((s) => s.label)).toEqual(['account opening balance (IIF list import or New Account)']);
    expect(furniture.balance).toBe(fxEnding(SAMPLE_GL).get('15000')!.toFixed(2));
    // Nothing from the GL was saved.
    const gl = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'qbgl:%')));
    expect(gl).toHaveLength(0);

    // Confirmed: imported, but the result says plainly that those accounts hold other entries.
    const ok = await runGlImport(ctx, { ...input, acceptExistingEntries: true });
    expect(ok.ok).toBe(true);
    expect(ok.message).not.toMatch(/Every account matches the QuickBooks report\.$/);
    expect(ok.message).toMatch(/also hold other entries/);
    expect(ok.warnings.some((w) => /weren't part of this import/.test(w) && w.includes('15000'))).toBe(true);
  }, 180_000);
});

describe('review13 #3 — IIF item types follow QuickBooks (PART = non-inventory, INVENTORY = inventory)', () => {
  it('maps the codes, with older PART-with-stock rows still read as inventory', () => {
    expect(mapIifItemType('PART')).toBe('non_inventory');
    expect(mapIifItemType('INVENTORY')).toBe('inventory');
    expect(mapIifItemType('ASSEMBLY')).toBe('inventory');
    expect(mapIifItemType('PART', { assetAccount: 'Inventory Asset' })).toBe('inventory');
    expect(mapIifItemType('PART', { quantityOnHand: '5' })).toBe('inventory');
    expect(mapIifItemType('PART', { assetAccount: '', quantityOnHand: '0', totalValue: '' })).toBe('non_inventory');
    expect(qbItemType('inventory', false)).toBe('INVENTORY');
    expect(qbItemType('inventory', true)).toBe('ASSEMBLY');
    expect(qbItemType('non_inventory', false)).toBe('PART');
  });

  it('imports a QuickBooks item list with the right types, and an Ironbooks export round-trips', async () => {
    const ctx = await newCo('Item Types');
    const iif = [
      '!INVITEM\tNAME\tINVITEMTYPE\tDESC\tPRICE\tCOST\tACCNT\tASSETACCNT\tCOGSACCNT',
      'INVITEM\tBrochure\tPART\tPrinted brochure\t5.00\t1.00\t\t\t',
      'INVITEM\tWidget\tINVENTORY\tBlue widget\t25.00\t10.00\t\tInventory Asset\t',
      'INVITEM\tOld Export Gizmo\tPART\tGizmo\t9.00\t3.00\t\tInventory Asset\t',
    ].join('\r\n');
    const counts = await importIIF(ctx, iif);
    expect(counts.items).toBe(3);
    const rows = await ctx.db.select({ name: items.name, type: items.type }).from(items).where(eq(items.companyId, ctx.companyId));
    const type = (n: string) => rows.find((r) => r.name === n)?.type;
    expect(type('Brochure')).toBe('non_inventory');
    expect(type('Widget')).toBe('inventory');
    expect(type('Old Export Gizmo')).toBe('inventory');

    const exported = await exportListsIif(ctx, ['items']);
    expect(exported).toMatch(/\nINVITEM\tWidget\tINVENTORY\t/);
    expect(exported).toMatch(/\nINVITEM\tBrochure\tPART\t/);
    const target = await newCo('Item Types Target');
    await importIIF(target, exported);
    const back = await db.select({ name: items.name, type: items.type }).from(items).where(eq(items.companyId, target.companyId));
    expect(Object.fromEntries(back.map((r) => [r.name, r.type]))).toEqual(
      Object.fromEntries(rows.map((r) => [r.name, r.type])),
    );
  }, 120_000);
});
