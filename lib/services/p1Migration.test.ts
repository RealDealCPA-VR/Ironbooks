/**
 * P1 migration fidelity:
 *  - IIF journal export writes the QB NAME column from journal_entry_lines (A/R / A/P lines carry
 *    the customer / vendor; a re-import restores the per-name detail);
 *  - QB General Ledger import puts the customer / vendor / employee on each imported line;
 *  - L4: OTHERNAME, TERMS, SHIPMETH, PAYMETH, CUSTMSG, SALESTAXCODE, JOBTYPE, VEH, PRICELEVEL and
 *    TODO import into their lists (de-duplicated by name) and are written by the IIF export.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  companies,
  customerMessages,
  customers,
  employees,
  jobTypes,
  jobs,
  journalEntries,
  journalEntryLines,
  otherNames,
  paymentMethods,
  paymentTerms,
  priceLevels,
  salesTaxCodes,
  shipViaMethods,
  todos,
  users,
  vehicles,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { postJournalEntry } from './posting';
import { importIIF } from './qbImport';
import { exportJournalIif, exportListsIif } from './iifExport';
import { runGlImport } from './qbGlImport';
import { SAMPLE_GL, glCsv, upload } from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-migration');
let db: DB;
let userId: string;

const t = (...c: string[]) => c.join('\t');

async function newCompany(name: string, seedCoa = true): Promise<ServiceContext> {
  const c = await createCompany(db, { name, ownerId: userId, seedCoa });
  return { db, companyId: c.id, userId };
}

async function acct(ctx: ServiceContext, code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return a;
}

describe('P1 migration fidelity', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1mig@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('IIF journal export writes NAME for A/R, A/P and other named lines, and a re-import restores them', async () => {
    const a = await newCompany('Export Names Co');
    const parent = await createCustomer(a, { displayName: 'Acme' });
    const job = await createCustomer(a, { displayName: 'Phase 2', parentId: parent.id });
    const vend = await createVendor(a, { displayName: 'Paper Supply' });
    const ar = (await a.db.select().from(accounts).where(and(eq(accounts.companyId, a.companyId), eq(accounts.subtype, 'accounts_receivable'))))[0];
    const ap = (await a.db.select().from(accounts).where(and(eq(accounts.companyId, a.companyId), eq(accounts.subtype, 'accounts_payable'))))[0];
    const income = (await a.db.select().from(accounts).where(and(eq(accounts.companyId, a.companyId), eq(accounts.type, 'revenue'))))[0];
    const expense = (await a.db.select().from(accounts).where(and(eq(accounts.companyId, a.companyId), eq(accounts.type, 'expense'))))[0];
    await postJournalEntry(a, {
      date: new Date('2026-03-01T00:00:00Z'),
      description: 'Charge the job',
      lines: [
        { accountId: ar.id, debit: '500.00', entityType: 'customer', entityId: job.id },
        { accountId: income.id, credit: '500.00' },
      ],
    });
    await postJournalEntry(a, {
      date: new Date('2026-03-02T00:00:00Z'),
      description: 'Vendor bill as JE',
      lines: [
        { accountId: expense.id, debit: '80.00', entityType: 'vendor', entityId: vend.id },
        { accountId: ap.id, credit: '80.00', entityType: 'vendor', entityId: vend.id },
      ],
    });
    const iif = await exportJournalIif(a, { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-12-31T00:00:00Z') });
    const rows = iif.split('\r\n').filter((l) => /^(TRNS|SPL)\t/.test(l)).map((l) => l.split('\t'));
    // Column order: TRNS, TRNSID, TRNSTYPE, DATE, ACCNT, NAME, ...
    const arRow = rows.find((r) => r[4] === ar.name)!;
    expect(arRow[5]).toBe('Acme:Phase 2');
    const apRow = rows.find((r) => r[4] === ap.name)!;
    expect(apRow[5]).toBe('Paper Supply');
    const incRow = rows.find((r) => r[4] === income.name)!;
    expect(incRow[5]).toBe('');

    // Round trip into a company that has the same names: lines come back named.
    const b = await newCompany('Import Names Co');
    const lists = await exportListsIif(a, ['customers', 'vendors']);
    await importIIF(b, lists);
    const counts = await importIIF(b, iif);
    expect(counts.transactions).toBe(2);
    const named = await b.db
      .select({ type: journalEntryLines.entityType, id: journalEntryLines.entityId, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(and(eq(journalEntries.companyId, b.companyId)));
    const [bJob] = await b.db.select().from(customers).where(and(eq(customers.companyId, b.companyId), eq(customers.displayName, 'Acme:Phase 2')));
    const [bVend] = await b.db.select().from(vendors).where(and(eq(vendors.companyId, b.companyId), eq(vendors.displayName, 'Paper Supply')));
    expect(bJob).toBeTruthy();
    expect(named.filter((l) => l.type === 'customer' && l.id === bJob.id)).toHaveLength(1);
    expect(named.filter((l) => l.type === 'vendor' && l.id === bVend.id)).toHaveLength(2);
  });

  it('QB GL import names A/R, A/P and paycheck lines with the customers, vendors and employees it creates', async () => {
    const ctx = await newCompany('GL Names Co', false);
    const res = await runGlImport(ctx, { file: upload('General Ledger.csv', glCsv(SAMPLE_GL)) });
    expect(res.ok).toBe(true);
    const lines = await ctx.db
      .select({
        code: accounts.code,
        subtype: accounts.subtype,
        ref: journalEntries.reference,
        type: journalEntryLines.entityType,
        id: journalEntryLines.entityId,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
      .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'qbgl:%')));
    const [acme] = await ctx.db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'Acme Corp')));
    const [job] = await ctx.db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'Acme Corp:Kitchen Remodel')));
    const [shell] = await ctx.db.select().from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.displayName, 'Shell Oil')));
    const [john] = await ctx.db.select().from(employees).where(and(eq(employees.companyId, ctx.companyId), eq(employees.lastName, 'Smith')));

    // Every transaction A/R line carries a customer and every A/P line a vendor.
    const txnLines = lines.filter((l) => l.ref !== 'QB-OPEN');
    for (const l of txnLines.filter((x) => x.subtype === 'accounts_receivable')) expect(l.type).toBe('customer');
    for (const l of txnLines.filter((x) => x.subtype === 'accounts_payable')) expect(l.type).toBe('vendor');
    // Invoice 1001: A/R and income lines → Acme Corp. Invoice 1002 → the job.
    const inv1001 = txnLines.filter((l) => l.ref === '1001' && l.code === '11000');
    expect(inv1001.map((l) => l.id)).toContain(acme.id);
    expect(txnLines.filter((l) => l.ref === '1002' && l.code === '11000').map((l) => l.id)).toEqual([job.id]);
    expect(txnLines.filter((l) => l.code === '40100' && l.type === 'customer').length).toBeGreaterThan(0);
    // Bill INV-77: A/P and the expense lines → Shell Oil (Expenses by Vendor).
    const bill = txnLines.filter((l) => l.ref === 'INV-77');
    expect(bill.every((l) => l.type === 'vendor' && l.id === shell.id)).toBe(true);
    // Paycheck 1004 → employee.
    const pay = txnLines.filter((l) => l.ref === '1004');
    expect(pay.some((l) => l.type === 'employee' && l.id === john.id)).toBe(true);
  });

  it('L4: imports the other IIF lists into their tables, links customers / jobs, de-duplicates, and exports them back', async () => {
    const ctx = await newCompany('Lists Co');
    const iif = [
      t('!OTHERNAME', 'NAME', 'BADDR1', 'BADDR2', 'PHONE1', 'EMAIL', 'NOTE', 'HIDDEN'),
      t('OTHERNAME', 'Owner Draw Payee', '1 Main St', 'Austin, TX 78701', '555-1000', 'owner@example.com', 'The owner', 'N'),
      t('!TERMS', 'NAME', 'DUEDAYS', 'MINDAYS', 'DISCPER', 'DISCDAYS', 'TERMSTYPE', 'HIDDEN'),
      t('TERMS', '2% 15 Net 45', '45', '', '2.0%', '15', '0', 'N'),
      t('TERMS', '10th of month', '10', '5', '', '', '1', 'N'),
      t('TERMS', 'Net 30', '30', '', '', '', '0', 'N'),
      t('!SHIPMETH', 'NAME', 'HIDDEN'),
      t('SHIPMETH', 'Freight Truck', 'N'),
      t('SHIPMETH', 'UPS', 'N'),
      t('!PAYMETH', 'NAME', 'HIDDEN'),
      t('PAYMETH', 'Wire', 'N'),
      t('!CUSTMSG', 'NAME', 'HIDDEN'),
      t('CUSTMSG', 'Thanks for choosing us!', 'N'),
      t('!SALESTAXCODE', 'CODE', 'DESC', 'TAXABLE', 'HIDDEN'),
      t('SALESTAXCODE', 'OOS', 'Out of state', 'N', 'N'),
      t('!JOBTYPE', 'NAME', 'HIDDEN'),
      t('JOBTYPE', 'Remodel', 'N'),
      t('JOBTYPE', 'Remodel:Kitchen', 'N'),
      t('!VEH', 'NAME', 'DESC', 'HIDDEN'),
      t('VEH', 'Truck 1', 'F-150', 'N'),
      t('!PRICELEVEL', 'NAME', 'PERCENT', 'HIDDEN'),
      t('PRICELEVEL', 'Wholesale', '-15.0%', 'N'),
      t('!TODO', 'NOTE', 'DATE', 'DONE'),
      t('TODO', 'Call the accountant', '4/15/2026', 'N'),
      t('!CUST', 'NAME', 'TERMS', 'SALESTAXCODE', 'PRICELEVEL', 'JOBTYPE'),
      t('CUST', 'Big Buyer', '2% 15 Net 45', 'OOS', 'Wholesale', ''),
      t('CUST', 'Big Buyer:Kitchen', '', '', '', 'Kitchen'),
      t('!VEND', 'NAME', 'TERMS'),
      t('VEND', 'Lumber Yard', '10th of month'),
    ].join('\r\n');
    const counts = await importIIF(ctx, iif);
    expect(counts.deferred.map((d) => d.list)).toEqual([]);
    expect(counts.lists).toMatchObject({
      OTHERNAME: 1, TERMS: 2, SHIPMETH: 1, PAYMETH: 1, CUSTMSG: 1, SALESTAXCODE: 1, JOBTYPE: 2, VEH: 1, PRICELEVEL: 1, TODO: 1,
    });

    const scope = <T extends { companyId: unknown }>(table: T) => eq((table as unknown as { companyId: never }).companyId, ctx.companyId);
    const [on] = await ctx.db.select().from(otherNames).where(and(scope(otherNames), eq(otherNames.name, 'Owner Draw Payee')));
    expect(on).toMatchObject({ phone: '555-1000', email: 'owner@example.com' });
    expect(on.address).toMatchObject({ city: 'Austin', state: 'TX', zip: '78701' });
    const terms = await ctx.db.select().from(paymentTerms).where(scope(paymentTerms));
    const t245 = terms.find((x) => x.name === '2% 15 Net 45')!;
    expect(t245).toMatchObject({ kind: 'standard', netDays: 45, discountDays: 15 });
    expect(Number(t245.discountPercent)).toBe(2);
    expect(terms.find((x) => x.name === '10th of month')).toMatchObject({ kind: 'date_driven', dueDayOfMonth: 10, dueNextMonthWithinDays: 5 });
    expect(terms.filter((x) => x.name === 'Net 30')).toHaveLength(1); // de-duplicated against the defaults
    expect((await ctx.db.select().from(shipViaMethods).where(scope(shipViaMethods))).filter((s) => s.name === 'UPS')).toHaveLength(1);
    expect((await ctx.db.select().from(paymentMethods).where(scope(paymentMethods))).find((p) => p.name === 'Wire')?.type).toBe('bank_transfer');
    expect((await ctx.db.select().from(customerMessages).where(scope(customerMessages))).some((m) => m.message === 'Thanks for choosing us!')).toBe(true);
    const oos = (await ctx.db.select().from(salesTaxCodes).where(scope(salesTaxCodes))).find((c) => c.code === 'OOS')!;
    expect(oos.taxable).toBe(false);
    const jt = await ctx.db.select().from(jobTypes).where(scope(jobTypes));
    const remodel = jt.find((j) => j.name === 'Remodel')!;
    const kitchen = jt.find((j) => j.name === 'Kitchen')!;
    expect(kitchen.parentId).toBe(remodel.id);
    expect((await ctx.db.select().from(vehicles).where(scope(vehicles)))[0]).toMatchObject({ name: 'Truck 1', description: 'F-150' });
    const [lvl] = await ctx.db.select().from(priceLevels).where(scope(priceLevels));
    expect(lvl).toMatchObject({ name: 'Wholesale', type: 'fixed_percent' });
    expect(Number(lvl.percent)).toBe(-15);
    const [todo] = await ctx.db.select().from(todos).where(scope(todos));
    expect(todo).toMatchObject({ title: 'Call the accountant', dueDate: '2026-04-15', done: false });

    // Customers / vendors / jobs link the real list entries.
    const [buyer] = await ctx.db.select().from(customers).where(and(scope(customers), eq(customers.displayName, 'Big Buyer')));
    expect(buyer).toMatchObject({ termsId: t245.id, salesTaxCodeId: oos.id, priceLevelId: lvl.id, taxable: false });
    const [kjob] = await ctx.db.select().from(jobs).where(and(scope(jobs), eq(jobs.name, 'Kitchen')));
    expect(kjob.jobTypeId).toBe(kitchen.id);
    const [lumber] = await ctx.db.select().from(vendors).where(and(scope(vendors), eq(vendors.displayName, 'Lumber Yard')));
    expect(lumber.termsId).toBe(terms.find((x) => x.name === '10th of month')!.id);

    // Re-importing adds nothing.
    const again = await importIIF(ctx, iif);
    expect(Object.values(again.lists).reduce((s, n) => s + n, 0)).toBe(0);

    // Export writes every section; importing it into an empty company rebuilds the lists.
    const out = await exportListsIif(ctx);
    for (const sec of ['TERMS', 'OTHERNAME', 'SHIPMETH', 'PAYMETH', 'CUSTMSG', 'SALESTAXCODE', 'JOBTYPE', 'VEH', 'PRICELEVEL', 'TODO']) {
      expect(out).toMatch(new RegExp(`^!${sec}\\t`, 'm'));
    }
    expect(out).toMatch(/^JOBTYPE\tRemodel:Kitchen\t/m);
    expect(out).toMatch(/^CUST\tBig Buyer\t/m);
    const other = await newCompany('Lists Copy Co');
    await importIIF(other, out);
    const [buyer2] = await other.db.select().from(customers).where(and(eq(customers.companyId, other.companyId), eq(customers.displayName, 'Big Buyer')));
    const [t2] = await other.db.select().from(paymentTerms).where(and(eq(paymentTerms.companyId, other.companyId), eq(paymentTerms.name, '2% 15 Net 45')));
    expect(buyer2.termsId).toBe(t2.id);
    expect(buyer2.priceLevelId).toBeTruthy();
    expect(buyer2.salesTaxCodeId).toBeTruthy();
    const [todo2] = await other.db.select().from(todos).where(eq(todos.companyId, other.companyId));
    expect(todo2.dueDate).toBe('2026-04-15');
    const [jk] = await other.db.select().from(jobTypes).where(and(eq(jobTypes.companyId, other.companyId), eq(jobTypes.name, 'Kitchen')));
    expect(jk.parentId).toBeTruthy();
  });
});
