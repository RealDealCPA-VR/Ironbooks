/**
 * Independent QA (tester) for the P1 migration items:
 *  - IIF journal export NAME column for employee and other-name lines, and the round trip;
 *  - QB name matching rules (A/R → customers only, A/P → vendors only, ambiguous names stay
 *    unnamed, case / spacing insensitive, never another company's names);
 *  - IIF OBAMOUNT: re-import does not double, closed periods are refused with a note,
 *    the ledger always balances;
 *  - L4 other lists: case-insensitive de-duplication, bad rows reported without aborting,
 *    two-digit years, hidden flags, payment-method types, export isolation between companies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  customers,
  employees,
  journalEntries,
  journalEntryLines,
  otherNames,
  paymentMethods,
  paymentTerms,
  priceLevels,
  shipViaMethods,
  todos,
  users,
  vehicles,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createEmployee } from './payroll';
import { createEntry } from './lists/simpleLists';
import { postJournalEntry } from './posting';
import { importIIF } from './qbImport';
import { exportJournalIif, exportListsIif } from './iifExport';
import { loadQbNameResolver } from './qbNameResolver';
import { trialBalance } from './reports';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-migration-qa');
let db: DB;
let userId: string;
const t = (...c: string[]) => c.join('\t');
const day = (s: string) => new Date(`${s}T00:00:00Z`);

async function newCompany(name: string, seedCoa = true): Promise<ServiceContext> {
  const c = await createCompany(db, { name, ownerId: userId, seedCoa });
  return { db, companyId: c.id, userId };
}
async function bySubtype(ctx: ServiceContext, subtype: string) {
  return (await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.subtype, subtype as never))))[0];
}
async function byType(ctx: ServiceContext, type: string) {
  return (await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.type, type as never))))[0];
}
async function lineNames(ctx: ServiceContext) {
  return ctx.db
    .select({ accountId: journalEntryLines.accountId, type: journalEntryLines.entityType, id: journalEntryLines.entityId })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(eq(journalEntries.companyId, ctx.companyId));
}

describe('P1 migration — tester QA', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1migqa@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('journal export names employee and other-name lines as the list export spells them; the round trip restores them', async () => {
    const a = await newCompany('Names Source Co');
    const e = await createEmployee(a, { firstName: 'Jane', lastName: 'Doe', payType: 'salary', payRate: '1' });
    const other = (await createEntry(a, 'other-names', { name: 'Owner Draws' })) as { id: string };
    const bank = await bySubtype(a, 'checking');
    const expense = await byType(a, 'expense');
    const equity = await byType(a, 'equity');
    await postJournalEntry(a, {
      date: day('2026-02-01'), description: 'Reimburse Jane',
      lines: [
        { accountId: expense.id, debit: '40.00', entityType: 'employee', entityId: e.id },
        { accountId: bank.id, credit: '40.00' },
      ],
    });
    await postJournalEntry(a, {
      date: day('2026-02-02'), description: 'Owner draw',
      lines: [
        { accountId: equity.id, debit: '100.00', entityType: 'other', entityId: other.id },
        { accountId: bank.id, credit: '100.00', entityType: 'other', entityId: other.id },
      ],
    });
    const jr = await exportJournalIif(a, { from: day('2026-01-01'), to: day('2026-12-31') });
    const rows = jr.split('\r\n').filter((l) => /^(TRNS|SPL)\t/.test(l)).map((l) => l.split('\t'));
    expect(rows.filter((r) => r[5] === 'Doe, Jane')).toHaveLength(1);
    expect(rows.filter((r) => r[5] === 'Owner Draws')).toHaveLength(2);
    // The list export spells them the same way.
    const lists = await exportListsIif(a, ['employees', 'other_lists']);
    expect(lists).toMatch(/^EMP\tDoe, Jane\t/m);
    expect(lists).toMatch(/^OTHERNAME\tOwner Draws\t/m);

    const b = await newCompany('Names Target Co');
    await importIIF(b, lists);
    const res = await importIIF(b, jr);
    expect(res.transactions).toBe(2);
    const [bJane] = await db.select().from(employees).where(and(eq(employees.companyId, b.companyId), eq(employees.lastName, 'Doe')));
    const [bOther] = await db.select().from(otherNames).where(and(eq(otherNames.companyId, b.companyId), eq(otherNames.name, 'Owner Draws')));
    const named = await lineNames(b);
    expect(named.filter((l) => l.type === 'employee' && l.id === bJane.id)).toHaveLength(1);
    expect(named.filter((l) => l.type === 'other' && l.id === bOther.id)).toHaveLength(2);
    expect((await trialBalance(b)).balanced).toBe(true);
  });

  it('name matching: A/R → customer only, A/P → vendor only, ambiguous stays unnamed, case-insensitive, company-scoped', async () => {
    const c = await newCompany('Resolver Co');
    const cust = await createCustomer(c, { displayName: 'Smith Co' });
    const vend = await createVendor(c, { displayName: 'Smith Co' });
    const onlyVend = await createVendor(c, { displayName: 'Paper Mill' });
    const parent = await createCustomer(c, { displayName: 'Acme Corp' });
    const job = await createCustomer(c, { displayName: 'Roof', parentId: parent.id });
    await createEmployee(c, { firstName: 'Mary', lastName: 'Major', payType: 'hourly', payRate: '1' });
    const elsewhere = await newCompany('Other Resolver Co');
    await createCustomer(elsewhere, { displayName: 'Only Elsewhere' });

    const r = await loadQbNameResolver(c);
    expect(r.resolve('Smith Co', { side: 'ar' })).toEqual({ entityType: 'customer', entityId: cust.id });
    expect(r.resolve('Smith Co', { side: 'ap' })).toEqual({ entityType: 'vendor', entityId: vend.id });
    expect(r.resolve('Smith Co')).toBeNull(); // ambiguous without a preference
    expect(r.resolve('Smith Co', { prefer: 'vendor' })).toEqual({ entityType: 'vendor', entityId: vend.id });
    expect(r.resolve('Paper Mill', { side: 'ar' })).toBeNull(); // a vendor never lands on A/R
    expect(r.resolve('  acme   corp : roof ')).toEqual({ entityType: 'customer', entityId: job.id });
    expect(r.resolve('ACME CORP')).toEqual({ entityType: 'customer', entityId: parent.id });
    expect(r.resolve('Major, Mary')?.entityType).toBe('employee');
    expect(r.resolve('mary major')?.entityType).toBe('employee');
    expect(r.resolve('Only Elsewhere')).toBeNull();
    expect(r.resolve('')).toBeNull();
    expect(r.resolve('Paper Mill')).toEqual({ entityType: 'vendor', entityId: onlyVend.id });
  });

  it('IIF transaction import: an A/R split without its own name takes the transaction name; unknown names stay unnamed and still balance', async () => {
    const c = await newCompany('Txn Names Co');
    const cust = await createCustomer(c, { displayName: 'Walk In' });
    const ar = await bySubtype(c, 'accounts_receivable');
    const income = await byType(c, 'revenue');
    const iif = [
      t('!TRNS', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM'),
      t('!SPL', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM'),
      '!ENDTRNS',
      t('TRNS', 'GENERAL JOURNAL', '3/1/2026', ar.name, 'walk in', '75.00', 'GJ1'),
      t('SPL', 'GENERAL JOURNAL', '3/1/2026', income.name, 'Nobody Known', '-75.00', 'GJ1'),
      'ENDTRNS',
    ].join('\r\n');
    const res = await importIIF(c, iif);
    expect(res.transactions).toBe(1);
    const named = await lineNames(c);
    expect(named.find((l) => l.accountId === ar.id)).toMatchObject({ type: 'customer', id: cust.id });
    expect(named.find((l) => l.accountId === income.id)?.type ?? null).toBeNull();
    expect((await trialBalance(c)).balanced).toBe(true);
  });

  it('OBAMOUNT: re-importing the same file does not double the opening balance', async () => {
    const c = await newCompany('OB Twice Co', false);
    const iif = [
      t('!ACCNT', 'NAME', 'ACCNTTYPE', 'ACCNUM', 'OBAMOUNT'),
      t('ACCNT', 'Savings', 'BANK', '1020', '2500.55'),
      t('ACCNT', 'Truck Loan', 'LTLIAB', '2700', '-10000.00'),
    ].join('\r\n');
    await importIIF(c, iif);
    await importIIF(c, iif);
    const [sav] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '1020')));
    const [loan] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '2700')));
    expect(Money.of(sav.balance).toFixed(2)).toBe('2500.55');
    expect(Money.of(loan.balance).abs().toFixed(2)).toBe('10000.00');
    const obEntries = await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId));
    expect(obEntries).toHaveLength(2);
    expect((await trialBalance(c)).balanced).toBe(true);
    // Round trip: the export writes the opening balance back with the IIF sign convention.
    const out = await exportListsIif(c, ['accounts']);
    expect(out).toMatch(/^ACCNT\tSavings\tBANK\t\t1020\t2500\.55\t/m);
    expect(out).toMatch(/^ACCNT\tTruck Loan\tLTLIAB\t\t2700\t-10000\.00\t/m);
  });

  it('OBAMOUNT dated in a closed period is not posted; the account still imports, a note explains, the ledger balances', async () => {
    const c = await newCompany('OB Closed Co', false);
    await setClosingDate(c, { closingDate: '2020-12-31' });
    const iif = [
      t('!ACCNT', 'NAME', 'ACCNTTYPE', 'ACCNUM', 'OBAMOUNT'),
      t('ACCNT', 'Old Bank', 'BANK', '1030', '900.00'),
      t('ACCNT', 'Sales', 'INC', '4000', ''),
      t('!TRNS', 'TRNSTYPE', 'DATE', 'ACCNT', 'AMOUNT'),
      t('!SPL', 'TRNSTYPE', 'DATE', 'ACCNT', 'AMOUNT'),
      '!ENDTRNS',
      t('TRNS', 'DEPOSIT', '6/1/2020', 'Old Bank', '10.00'),
      t('SPL', 'DEPOSIT', '6/1/2020', 'Sales', '-10.00'),
      'ENDTRNS',
    ].join('\r\n');
    const res = await importIIF(c, iif);
    const [bank] = await db.select().from(accounts).where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '1030')));
    expect(bank).toBeTruthy();
    expect(Money.of(bank.balance).toFixed(2)).toBe('0.00');
    expect(res.issues.some((i) => i.name === 'Old Bank' && /opening balance/i.test(i.message))).toBe(true);
    expect((await trialBalance(c)).balanced).toBe(true);
  });

  it('L4: case-insensitive de-duplication, bad rows reported (import continues), two-digit years, hidden flags, payment types', async () => {
    const c = await newCompany('Lists QA Co');
    const iif = [
      t('!TERMS', 'NAME', 'DUEDAYS', 'MINDAYS', 'DISCPER', 'DISCDAYS', 'TERMSTYPE', 'HIDDEN'),
      t('TERMS', 'net 30', '30', '', '', '', '0', 'N'),
      t('TERMS', 'Net 60 Old', '60', '', '', '', '0', 'Y'),
      t('!SHIPMETH', 'NAME', 'HIDDEN'),
      t('SHIPMETH', 'Courier X', 'N'),
      t('SHIPMETH', 'COURIER x', 'N'),
      t('!PAYMETH', 'NAME', 'HIDDEN'),
      t('PAYMETH', 'Store Visa Card', 'N'),
      t('PAYMETH', 'visa', 'N'), // already a default (case-insensitive)
      t('PAYMETH', 'Online ACH', 'N'),
      t('PAYMETH', 'Petty Cash', 'N'),
      t('!PRICELEVEL', 'NAME', 'PERCENT', 'HIDDEN'),
      t('PRICELEVEL', 'Impossible', '-150%', 'N'),
      t('PRICELEVEL', 'Retail Plus', '10%', 'N'),
      t('!VEH', 'NAME', 'DESC', 'HIDDEN'),
      t('VEH', 'Van', 'Old van', 'Y'),
      t('!TODO', 'NOTE', 'DATE', 'DONE'),
      t('TODO', 'File the 941', '4/30/26', 'Y'),
    ].join('\r\n');
    const res = await importIIF(c, iif);
    expect(res.lists).toMatchObject({ TERMS: 1, SHIPMETH: 1, PAYMETH: 3, PRICELEVEL: 1, VEH: 1, TODO: 1 });
    expect(res.issues.some((i) => i.name === 'Impossible')).toBe(true);
    const scoped = <T>(rows: T[]) => rows;
    const terms = scoped(await db.select().from(paymentTerms).where(eq(paymentTerms.companyId, c.companyId)));
    expect(terms.filter((x) => x.name.toLowerCase() === 'net 30')).toHaveLength(1);
    expect(terms.find((x) => x.name === 'Net 60 Old')?.isActive).toBe(false);
    const ships = await db.select().from(shipViaMethods).where(eq(shipViaMethods.companyId, c.companyId));
    expect(ships.filter((s) => s.name.toLowerCase() === 'courier x')).toHaveLength(1);
    const pms = await db.select().from(paymentMethods).where(eq(paymentMethods.companyId, c.companyId));
    expect(pms.find((p) => p.name === 'Store Visa Card')?.type).toBe('credit_card');
    expect(pms.find((p) => p.name === 'Online ACH')?.type).toBe('ach');
    expect(pms.find((p) => p.name === 'Petty Cash')?.type).toBe('cash');
    expect(pms.filter((p) => p.name.toLowerCase() === 'visa')).toHaveLength(1);
    const levels = await db.select().from(priceLevels).where(eq(priceLevels.companyId, c.companyId));
    expect(levels.map((l) => l.name)).toEqual(['Retail Plus']);
    expect(Number(levels[0].percent)).toBe(10);
    const [van] = await db.select().from(vehicles).where(eq(vehicles.companyId, c.companyId));
    expect(van.isActive).toBe(false);
    const [todo] = await db.select().from(todos).where(eq(todos.companyId, c.companyId));
    expect(todo).toMatchObject({ title: 'File the 941', dueDate: '2026-04-30', done: true });

    // Export: another company's list entries never leak into this company's file.
    const other = await newCompany('Lists QA Other Co');
    await createEntry(other, 'vehicles', { name: 'Secret Truck' });
    const out = await exportListsIif(c, ['other_lists']);
    expect(out).toMatch(/^VEH\tVan\tOld van\tY/m);
    expect(out).not.toMatch(/Secret Truck/);
    expect(out).toMatch(/^PRICELEVEL\tRetail Plus\t10%\tN/m);
    expect(out).toMatch(/^TODO\tFile the 941\t4\/30\/2026\tY/m);
  });
});
