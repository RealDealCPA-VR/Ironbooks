/**
 * Regression tests from the data in/out review (merge, per-company backup/restore, condense).
 *
 *  1. mergeAccounts re-points every reference to the merged-away account — deposit lines (and the
 *     "cashback:<accountId>" marker), not just a hand-maintained list — so re-saving a deposit can
 *     never post to the deactivated account.
 *  2. Per-company restore carries every company-scoped table (payment terms, Other Names, ...),
 *     guarded by a catalog-driven coverage check with an explicit exclusion list.
 *  3. Per-company restore remaps ids embedded in text (deposit-line "salesReceipt:<id>" /
 *     "cashback:<id>" markers, journal source refs), so a deposited receipt stays deposited.
 *  4. Condense keeps the foreign-currency columns, so a foreign account keeps its own-currency
 *     balance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, and, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users, companies, depositLines, deposits, journalEntryLines, journalEntries, customers,
  paymentTerms, otherNames, salesReceipts, accounts,
} from '@/lib/db/schema';
import {
  createCompanyBackup, restoreCompanyBackup, COMPANY_BACKUP_TABLE_NAMES, COMPANY_BACKUP_EXCLUDED_TABLES,
} from './backup';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createDeposit, getDeposit, updateDeposit, listUndepositedPayments, CASHBACK_LINE_PREFIX } from './deposits';
import { postJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { foreignAccountBalances } from './fxLedger';
import { condensePeriod, condenseArchiveDir } from './condense';
import { mergeAccounts } from './merge';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review-data');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
const createdArchives: string[] = [];

async function postedLinesOn(accountId: string): Promise<number> {
  const rows = await db
    .select({ id: journalEntryLines.id })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(and(eq(journalEntryLines.accountId, accountId), eq(journalEntries.status, 'posted')));
  return rows.length;
}

describe('data in/out review regressions', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rv@test.local', name: 'RV', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'RV Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Petty Cash A', 'asset', 'checking'],
      ['1011', 'Petty Cash B', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['4100', 'Other Income A', 'revenue', 'other_income'],
      ['4200', 'Other Income B', 'revenue', 'other_income'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
  }, 120000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    for (const f of createdArchives) fs.rmSync(f, { force: true });
  });

  it('mergeAccounts re-points deposit lines, so re-saving a deposit never posts to the merged-away account', async () => {
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: new Date('2025-06-05'),
      extraLines: [{ accountId: acct['4100'], amount: '100.00', description: 'misc' }],
    });
    await mergeAccounts(ctx, { fromId: acct['4100'], toId: acct['4200'] });
    const lines = await db.select().from(depositLines).where(eq(depositLines.depositId, dep.id));
    expect(lines[0].accountId).toBe(acct['4200']);

    const d = await getDeposit(ctx, dep.id);
    await updateDeposit(ctx, dep.id, {
      depositAccountId: d.depositAccountId,
      date: d.date,
      extraLines: d.lines.map((l) => ({ accountId: l.accountId!, amount: l.amount, description: l.description })),
      memo: 'edited',
    });
    expect(await postedLinesOn(acct['4100'])).toBe(0);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  }, 120000);

  it('mergeAccounts re-points the cash-back marker on deposit lines', async () => {
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: new Date('2025-06-06'),
      extraLines: [{ accountId: acct['4200'], amount: '80.00', description: 'misc' }],
      cashBack: { accountId: acct['1010'], amount: '20.00' },
    });
    await mergeAccounts(ctx, { fromId: acct['1010'], toId: acct['1011'] });
    const lines = await db.select().from(depositLines).where(eq(depositLines.depositId, dep.id));
    const descs = lines.map((l) => l.description ?? '');
    expect(descs).toContain(`${CASHBACK_LINE_PREFIX}${acct['1011']}`);
    expect(descs.some((x) => x.includes(acct['1010']))).toBe(false);
  }, 120000);

  it('every company-scoped table is either in the per-company backup or explicitly excluded', async () => {
    const res = await db.execute(sql`
      SELECT DISTINCT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND c.column_name = 'company_id'
       ORDER BY 1`);
    const scoped = ((res as unknown as { rows: Array<{ table_name: string }> }).rows).map((r) => r.table_name);
    const carried = new Set(COMPANY_BACKUP_TABLE_NAMES);
    const uncovered = scoped.filter((t) => !carried.has(t) && !(t in COMPANY_BACKUP_EXCLUDED_TABLES));
    expect(uncovered).toEqual([]);
    // An exclusion must name a real table that is not also carried, and give a reason.
    for (const [t, reason] of Object.entries(COMPANY_BACKUP_EXCLUDED_TABLES)) {
      expect(scoped).toContain(t);
      expect(carried.has(t)).toBe(false);
      expect(reason.length).toBeGreaterThan(10);
    }
  }, 120000);

  it('per-company backup/restore keeps payment terms on customers and the Other Names list', async () => {
    const [term] = await db.insert(paymentTerms).values({ companyId: ctx.companyId, name: 'Net 45 Special' }).returning();
    await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Termed Cust', termsId: term.id });
    await db.insert(otherNames).values({ companyId: ctx.companyId, name: 'Owner Draw Person' });
    const { buffer } = await createCompanyBackup(db, ctx.companyId);
    const res = await restoreCompanyBackup(db, buffer, { ownerId: ctx.userId!, name: 'RV Restored' });
    const [c] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.companyId, res.companyId), eq(customers.displayName, 'Termed Cust')));
    const terms = await db.select().from(paymentTerms).where(eq(paymentTerms.companyId, res.companyId));
    const names = await db.select().from(otherNames).where(eq(otherNames.companyId, res.companyId));
    expect(terms.map((x) => x.name)).toEqual(['Net 45 Special']);
    expect(c.termsId).toBe(terms[0].id);
    expect(names.map((x) => x.name)).toEqual(['Owner Draw Person']);
  }, 120000);

  it('per-company restore remaps ids inside deposit-line markers and source refs (no double deposit)', async () => {
    const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'SR Cust' }).returning();
    await postJournalEntry(ctx, {
      allowUnnamedControl: true,
      date: new Date('2025-06-02'),
      description: 'SR',
      lines: [
        { accountId: acct['1050'], debit: '150.00' },
        { accountId: acct['4000'], credit: '150.00' },
      ],
    });
    const [sr] = await db
      .insert(salesReceipts)
      .values({
        companyId: ctx.companyId, customerId: cust.id, receiptNumber: 1, date: new Date('2025-06-02'),
        method: 'cash', status: 'paid', subtotal: '150.00', total: '150.00', depositAccountId: acct['1050'],
      })
      .returning();
    await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: new Date('2025-06-07'),
      salesReceiptIds: [sr.id],
      cashBack: { accountId: acct['1011'], amount: '10.00' },
    });
    expect((await listUndepositedPayments(ctx)).filter((i) => i.kind === 'sales_receipt')).toHaveLength(0);

    const { buffer } = await createCompanyBackup(db, ctx.companyId);
    const res = await restoreCompanyBackup(db, buffer, { ownerId: ctx.userId!, name: 'RV Restored 2' });
    const ctx2: ServiceContext = { ...ctx, companyId: res.companyId };
    expect((await listUndepositedPayments(ctx2)).filter((i) => i.kind === 'sales_receipt')).toHaveLength(0);

    // Every embedded id now names a row of the restored company.
    const newAccountIds = new Set(
      (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.companyId, res.companyId))).map((a) => a.id),
    );
    const newReceiptIds = new Set(
      (await db.select({ id: salesReceipts.id }).from(salesReceipts).where(eq(salesReceipts.companyId, res.companyId))).map((r) => r.id),
    );
    const markers = (
      await db
        .select({ description: depositLines.description })
        .from(depositLines)
        .innerJoin(deposits, eq(deposits.id, depositLines.depositId))
        .where(eq(deposits.companyId, res.companyId))
    ).map((l) => l.description ?? '');
    const cash = markers.filter((m) => m.startsWith(CASHBACK_LINE_PREFIX)).map((m) => m.slice(CASHBACK_LINE_PREFIX.length));
    const rcpt = markers.filter((m) => m.startsWith('salesReceipt:')).map((m) => m.slice('salesReceipt:'.length));
    expect(cash.length).toBeGreaterThan(0);
    expect(cash.every((id) => newAccountIds.has(id))).toBe(true);
    expect(rcpt.length).toBe(1);
    expect(rcpt.every((id) => newReceiptIds.has(id))).toBe(true);

    const newDepositIds = new Set(
      (await db.select({ id: deposits.id }).from(deposits).where(eq(deposits.companyId, res.companyId))).map((d) => d.id),
    );
    const refs = (
      await db.select({ ref: journalEntries.sourceRef }).from(journalEntries).where(eq(journalEntries.companyId, res.companyId))
    )
      .map((r) => r.ref ?? '')
      .filter((r) => r.startsWith('deposit:'));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => newDepositIds.has(r.slice('deposit:'.length)))).toBe(true);
  }, 120000);

  it('condense keeps a foreign-currency bank account balance in its own currency', async () => {
    const [company] = await db.insert(companies).values({ name: 'RV FX Co', ownerId: ctx.userId! }).returning();
    const c3: ServiceContext = { db, companyId: company.id, userId: ctx.userId };
    const eur = (await createAccount(c3, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    const usd = (await createAccount(c3, { code: '1000', name: 'Checking', type: 'asset' as never, subtype: 'checking' })).id;
    const eq3 = (await createAccount(c3, { code: '3000', name: 'Equity', type: 'equity' as never, subtype: 'owners_equity' })).id;
    await setBaseCurrency(c3, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(c3, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await setAccountCurrency(c3, eur, 'EUR');
    await postJournalEntry(c3, {
      date: new Date('2024-01-10T12:00:00Z'), description: 'EUR in', currency: 'EUR', exchangeRate: '1.10',
      lines: [{ accountId: eur, debit: '1100.00', foreignAmount: '1000.00' }, { accountId: eq3, credit: '1100.00' }],
    });
    await postJournalEntry(c3, {
      date: new Date('2024-01-20T12:00:00Z'), description: 'EUR in again', currency: 'EUR', exchangeRate: '1.20',
      lines: [{ accountId: eur, debit: '600.00', foreignAmount: '500.00' }, { accountId: eq3, credit: '600.00' }],
    });
    await postJournalEntry(c3, {
      date: new Date('2024-01-25T12:00:00Z'), description: 'EUR out', currency: 'EUR', exchangeRate: '1.10',
      lines: [{ accountId: usd, debit: '220.00' }, { accountId: eur, credit: '220.00', foreignAmount: '200.00' }],
    });
    const read = async () => {
      const b = (await foreignAccountBalances(c3, new Date('2025-01-01'))).find((a) => a.accountId === eur)!;
      return { foreign: b.foreign.toFixed(2), home: b.home.toFixed(2) };
    };
    const before = await read();
    expect(before).toEqual({ foreign: '1300.00', home: '1480.00' });
    await db.update(companies).set({ settings: { closingDate: '2024-01-31' } as never }).where(eq(companies.id, c3.companyId));
    const archiveDir = condenseArchiveDir(TEST_DIR);
    const had = new Set(fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : []);
    await condensePeriod(c3, { beforeDate: new Date('2024-02-01T00:00:00Z'), dataDir: TEST_DIR });
    for (const f of fs.readdirSync(archiveDir)) if (!had.has(f) && f.endsWith('.bka')) createdArchives.push(path.join(archiveDir, f));
    expect(await read()).toEqual(before);
    expect((await trialBalance(c3)).balanced).toBe(true);
  }, 120000);
});
