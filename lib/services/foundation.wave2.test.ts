/**
 * Wave-2 GL foundation (drizzle/0025_wave2_foundation.sql):
 *  - B1 QuickBooks account types (incl. non-posting) + legacy reclassification + consumers
 *  - I11 names on journal lines (A/R needs a customer, A/P a vendor) feeding aging / balances
 *  - I9 adjusting-entry flag + getAdjustingEntries
 *  - B2 income-tax lines on accounts + getTaxLineMapping
 *  - A3 alphanumeric document numbers (docNumbers.ts + ref_number trigger)
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, estimates, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { qbAccountTypeOf, isCashAccount } from '@/lib/accountTypes';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import {
  createAccount,
  getTaxLineMapping,
  listAccounts,
  setIncomeTaxForm,
  updateAccount,
} from './accounts';
import { createCustomer, customerBalanceSummary } from './customers';
import { createVendor } from './vendors';
import { postJournalEntry } from './posting';
import {
  createManualEntry,
  getAdjustingEntries,
  getEntry,
  journalOpenItems,
  listRegisterAccounts,
  reverseEntry,
  updateEntry,
} from './journal';
import { apAging, arAging, arAgingDetail, cashFlow } from './reportsExtra';
import { createInvoice } from './invoices';
import { createPurchaseOrder } from './purchaseOrders';
import { customerStatement } from './statements';
import { trialBalance } from './reports';
import { verifyIntegrity } from './integrity';
import { getDashboardInsights } from './dashboard';
import {
  allocateDocNumber,
  assertUniqueDocNumber,
  docNumberToInt,
  getDocNumberSettings,
  incrementAlnum,
  nextDocNumber,
  setStartingDocNumber,
} from './docNumbers';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
let customerId: string;
let customer2Id: string;
let vendorId: string;

async function idByCode(c: string) {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
  return row.id;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation@test.local', name: 'W2', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Wave2 Foundation Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1050', '1200', '2000', '2200', '2300', '3000', '4000', '6000', '6200']) {
    code[c] = await idByCode(c);
  }
  customerId = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
  customer2Id = (await createCustomer(ctx, { displayName: 'Beta LLC' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'Paper Supply Co' })).id;
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// B1 — account types
// ---------------------------------------------------------------------------

describe('QuickBooks account types', () => {
  it('seeds Undeposited Funds as an Other Current Asset and tax/payroll liabilities as OCL', async () => {
    const rows = await listAccounts(ctx);
    const by = new Map(rows.map((r) => [r.code, r]));
    expect(by.get('1050')!.subtype).toBe('undeposited_funds');
    expect(by.get('1050')!.qbType).toBe('other_current_asset');
    expect(by.get('1000')!.qbType).toBe('bank');
    expect(by.get('2200')!.qbType).toBe('other_current_liability');
    expect(by.get('2300')!.qbType).toBe('other_current_liability');
    expect(by.get('2000')!.qbType).toBe('accounts_payable');
    expect(isCashAccount(by.get('1050')!)).toBe(true);
  });

  it('creates accounts from a QB account type and defaults blanks to OCA / OCL', async () => {
    const prepaid = await createAccount(ctx, { code: '1400', name: 'Prepaid Insurance', qbType: 'other_current_asset' });
    expect(prepaid.type).toBe('asset');
    expect(prepaid.subtype).toBe('other_current_asset');
    const loan = await createAccount(ctx, { code: '2700', name: 'Truck Loan', qbType: 'long_term_liability' });
    expect(loan.subtype).toBe('long_term_liability');
    const interest = await createAccount(ctx, { code: '8000', name: 'Interest Expense', qbType: 'Other Expense' });
    expect(interest.type).toBe('expense');
    expect(interest.subtype).toBe('other_expense');
    const blankAsset = await createAccount(ctx, { code: '1410', name: 'Deposit', type: 'asset', subtype: '' });
    expect(blankAsset.subtype).toBe('other_current_asset');
    const blankLiab = await createAccount(ctx, { code: '2410', name: 'Accrued Rent', type: 'liability' });
    expect(blankLiab.subtype).toBe('other_current_liability');
  });

  it('rejects a subtype that belongs to another base type or QB type', async () => {
    await expect(createAccount(ctx, { code: '6999', name: 'Bad', type: 'expense', subtype: 'checking' })).rejects.toThrow(/belongs to asset/);
    await expect(createAccount(ctx, { code: '6998', name: 'Bad', qbType: 'bank', subtype: 'credit_card' })).rejects.toThrow(/does not belong/);
    await expect(createAccount(ctx, { code: '6997', name: 'Bad', qbType: 'nonsense' })).rejects.toThrow(/Invalid account type/);
    await expect(createAccount(ctx, { code: '6996', name: 'Bad', qbType: 'bank', type: 'liability' })).rejects.toThrow(/asset type/);
  });

  it('changes the QB type of an account without history, refuses a base-type change with history', async () => {
    const acct = await createAccount(ctx, { code: '1420', name: 'Employee Advances', qbType: 'bank' });
    const moved = await updateAccount(ctx, acct.id, { qbType: 'other_current_asset' });
    expect(moved.qbType).toBe('other_current_asset');
    const toExpense = await updateAccount(ctx, acct.id, { qbType: 'expense' });
    expect(toExpense.type).toBe('expense');
    // With posted history, switching asset<->expense is refused.
    await postJournalEntry(ctx, {
      date: new Date(2026, 0, 5),
      description: 'use',
      lines: [
        { accountId: code['6200'], debit: '5.00' },
        { accountId: code['1000'], credit: '5.00' },
      ],
    });
    await expect(updateAccount(ctx, code['6200'], { qbType: 'other_current_asset' })).rejects.toThrow(/already has transactions/);
    // Same base type (expense -> other expense) is allowed even with history.
    const other = await updateAccount(ctx, code['6200'], { qbType: 'other_expense' });
    expect(other.subtype).toBe('other_expense');
    await updateAccount(ctx, code['6200'], { qbType: 'expense' });
  });

  it('non-posting accounts can never carry posted amounts (service and database)', async () => {
    const np = await createAccount(ctx, { code: '9000', name: 'Estimates', qbType: 'non_posting' });
    expect(qbAccountTypeOf(np)).toBe('non_posting');
    await expect(
      createAccount(ctx, { code: '9001', name: 'POs', qbType: 'non_posting', openingBalance: '10' }),
    ).rejects.toThrow(/non-posting/);
    await expect(
      postJournalEntry(ctx, {
        date: new Date(2026, 0, 6),
        description: 'np',
        lines: [
          { accountId: np.id, debit: '1.00' },
          { accountId: code['1000'], credit: '1.00' },
        ],
      }),
    ).rejects.toThrow(/non-posting/);
    // Raw SQL bypassing the service is refused at COMMIT by the deferred trigger.
    await expect(
      db.transaction(async (tx) => {
        const [e] = await tx
          .insert(journalEntries)
          .values({
            companyId: ctx.companyId,
            entryNumber: 99_999,
            date: new Date(2026, 0, 6),
            description: 'raw',
            status: 'posted',
            createdBy: ctx.userId!,
          })
          .returning();
        await tx.insert(journalEntryLines).values([
          { journalEntryId: e.id, accountId: np.id, debit: '1.00' },
          { journalEntryId: e.id, accountId: code['1000'], credit: '1.00' },
        ]);
      }),
    ).rejects.toThrow(/non-posting/);
    // An account with posted history cannot become non-posting.
    await expect(
      db.update(accounts).set({ subtype: 'non_posting' }).where(eq(accounts.id, code['1000'])),
    ).rejects.toThrow(/non-posting/);
    // And it never reaches the trial balance.
    const tb = await trialBalance(ctx);
    expect(JSON.stringify(tb)).not.toContain(np.id);
  });

  it('dashboard cash excludes prepaids; A/P excludes other current liabilities', async () => {
    const prepaid = (await listAccounts(ctx)).find((a) => a.code === '1400')!;
    await postJournalEntry(ctx, {
      date: new Date(2026, 0, 7),
      description: 'Prepay insurance',
      lines: [
        { accountId: prepaid.id, debit: '300.00' },
        { accountId: code['1000'], credit: '300.00' },
      ],
    });
    await postJournalEntry(ctx, {
      date: new Date(2026, 0, 7),
      description: 'Sales tax owed',
      lines: [
        { accountId: code['1000'], debit: '40.00' },
        { accountId: code['2200'], credit: '40.00' },
      ],
    });
    const before = await listAccounts(ctx);
    const bank = before.filter((a) => a.subtype === 'checking' || a.subtype === 'savings' || a.subtype === 'undeposited_funds');
    const expectedCash = bank.reduce((s, a) => s + Number(a.balance), 0);
    const insights = await getDashboardInsights(ctx, new Date(2026, 5, 15));
    expect(Number(insights.kpis.cash)).toBeCloseTo(expectedCash, 2);
    expect(insights.kpis.accountsPayable).toBe('0.00');
    // Cash-flow: prepaid growth is an operating use of cash, sales tax an operating source.
    const cf = await cashFlow(ctx, { from: new Date(2026, 0, 7), to: new Date(2026, 0, 7, 23) });
    const other = cf.operating.otherChanges;
    expect(other.find((l) => l.name === 'Prepaid Insurance')?.amount).toBe('-300.00');
    expect(other.find((l) => l.name === 'Sales Tax Payable')?.amount).toBe('40.00');
    expect(cf.financing.lines.find((l) => l.name === 'Sales Tax Payable')).toBeUndefined();
  });

  it('registers include other current assets / liabilities', async () => {
    const regs = await listRegisterAccounts(ctx);
    const codes = regs.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['1000', '1050', '1200', '2000', '2200', '1400']));
    expect(codes).not.toContain('9000');
  });

  it('migration SQL reclassifies legacy subtypes conservatively', async () => {
    const legacy: Array<[string, string, 'asset' | 'liability', string]> = [
      ['1901', 'Undeposited Funds (old)', 'asset', 'checking'],
      ['1902', 'Prepaid Rent', 'asset', 'checking'],
      ['1903', 'Operating Checking', 'asset', 'checking'],
      ['2901', 'Line of Credit', 'liability', 'accounts_payable'],
      ['2902', 'Accounts Payable - Trade', 'liability', 'accounts_payable'],
      ['2903', 'State Sales Tax Payable', 'liability', 'long_term_liability'],
      ['2904', 'Mortgage Note', 'liability', 'long_term_liability'],
      ['1904', 'Security Deposit', 'asset', 'checking'],
    ];
    for (const [c, name, type, subtype] of legacy) {
      await db.insert(accounts).values({ companyId: ctx.companyId, code: c, name, type, subtype: subtype as never });
    }
    const file = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0025_wave2_foundation.sql'), 'utf8');
    // The reclassification runs once, inside the migration's guarded DO block.
    const updates = (file.match(/UPDATE "accounts" SET "subtype"[\s\S]*?;/g) ?? []).map((s) => s.trim());
    expect(updates.length).toBe(5);
    for (const stmt of updates) await db.execute(sql.raw(stmt));
    const rows = await listAccounts(ctx);
    const sub = (c: string) => rows.find((r) => r.code === c)!.subtype;
    expect(sub('1901')).toBe('undeposited_funds');
    expect(sub('1902')).toBe('other_current_asset');
    expect(sub('1903')).toBe('checking');
    expect(sub('2901')).toBe('other_current_liability');
    expect(sub('2902')).toBe('accounts_payable');
    expect(sub('2903')).toBe('other_current_liability');
    expect(sub('2904')).toBe('long_term_liability');
    expect(sub('1904')).toBe('other_asset');
    // Seeded defaults are untouched by a re-run.
    expect(sub('2000')).toBe('accounts_payable');
    expect(sub('1000')).toBe('checking');
  });
});

// ---------------------------------------------------------------------------
// I11 — names on journal lines
// ---------------------------------------------------------------------------

describe('names on journal entry lines', () => {
  let arEntryId: string;

  it('requires a customer on A/R lines and a vendor on A/P lines', async () => {
    await expect(
      createManualEntry(ctx, {
        date: new Date(2026, 1, 1),
        description: 'AR without name',
        lines: [
          { accountId: code['1200'], debit: '100.00' },
          { accountId: code['4000'], credit: '100.00' },
        ],
      }),
    ).rejects.toThrow(/needs a customer/);
    await expect(
      createManualEntry(ctx, {
        date: new Date(2026, 1, 1),
        description: 'AR with vendor',
        lines: [
          { accountId: code['1200'], debit: '100.00', entityType: 'vendor', entityId: vendorId },
          { accountId: code['4000'], credit: '100.00' },
        ],
      }),
    ).rejects.toThrow(/needs a customer/);
    await expect(
      createManualEntry(ctx, {
        date: new Date(2026, 1, 1),
        description: 'AP without vendor',
        lines: [
          { accountId: code['6000'], debit: '50.00' },
          { accountId: code['2000'], credit: '50.00' },
        ],
      }),
    ).rejects.toThrow(/needs a vendor/);
    await expect(
      createManualEntry(ctx, {
        date: new Date(2026, 1, 1),
        description: 'unknown customer',
        lines: [
          { accountId: code['1200'], debit: '100.00', entityType: 'customer', entityId: '00000000-0000-4000-8000-000000000001' },
          { accountId: code['4000'], credit: '100.00' },
        ],
      }),
    ).rejects.toThrow(/not found/);
  });

  it('posts named A/R and A/P lines and stores the names', async () => {
    const e = await createManualEntry(ctx, {
      date: new Date(2026, 1, 1),
      description: 'Bill customers for setup fee',
      lines: [
        { accountId: code['1200'], debit: '250.00', entityType: 'customer', entityId: customerId },
        { accountId: code['1200'], debit: '50.00', entityType: 'customer', entityId: customer2Id },
        { accountId: code['4000'], credit: '300.00' },
      ],
    });
    arEntryId = e.id;
    const detail = await getEntry(ctx, e.id);
    expect(detail.lines.map((l) => l.entityName).filter(Boolean).sort()).toEqual(['Acme Corp', 'Beta LLC']);
    await createManualEntry(ctx, {
      date: new Date(2026, 1, 2),
      description: 'Accrue vendor invoice',
      lines: [
        { accountId: code['6000'], debit: '75.00', entityType: 'vendor', entityId: vendorId },
        { accountId: code['2000'], credit: '75.00', entityType: 'vendor', entityId: vendorId },
      ],
    });
  });

  it('named lines appear in A/R + A/P aging, customer balance and statements', async () => {
    const asOf = new Date(2026, 2, 15); // ~42 days after the entry
    const ar = await arAging(ctx, asOf);
    const acme = ar.rows.find((r) => r.id === customerId)!;
    expect(acme.total).toBe('250.00');
    expect(acme.days31_60).toBe('250.00');
    const detail = await arAgingDetail(ctx, asOf);
    expect(detail.rows.some((r) => r.docType === 'journal_entry' && r.entityId === customer2Id && r.openBalance === '50.00')).toBe(true);
    const ap = await apAging(ctx, asOf);
    expect(ap.rows.find((r) => r.id === vendorId)!.total).toBe('75.00');

    const summary = await customerBalanceSummary(ctx);
    expect(summary.find((r) => r.customerId === customerId)!.totalBalanceDue).toBe('250.00');

    const stmt = await customerStatement(ctx, customerId, { from: new Date(2026, 0, 1), to: new Date(2026, 2, 31) });
    expect(stmt.lines.some((l) => l.type === 'general_journal' && l.amount === '250.00')).toBe(true);
    expect(stmt.closingBalance).toBe('250.00');

    // A/R control check counts named General Journal items as open receivables.
    const integrity = await verifyIntegrity(ctx);
    const arCheck = integrity.checks.find((c) => c.name.startsWith('A/R control'))!;
    expect(arCheck.ok).toBe(true);
  });

  it('edit and reverse keep the names; a reversal nets the customer to zero', async () => {
    const before = await getEntry(ctx, arEntryId);
    const edited = await updateEntry(ctx, arEntryId, {
      date: before.date,
      description: before.description,
      lines: before.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        entityType: l.entityType,
        entityId: l.entityId,
      })),
    });
    await reverseEntry(ctx, edited.id, new Date(2026, 3, 1));
    const items = await journalOpenItems(ctx, 'ar', { entityId: customerId });
    const net = items.reduce((s, i) => s + Number(i.amount), 0);
    expect(net).toBeCloseTo(0, 2);
  });
});

// ---------------------------------------------------------------------------
// I9 — adjusting entries
// ---------------------------------------------------------------------------

describe('adjusting journal entries', () => {
  it('flags entries and lists them in the Adjusting Journal Entries data', async () => {
    const adj = await createManualEntry(ctx, {
      date: new Date(2026, 11, 31),
      description: 'Year-end depreciation',
      isAdjusting: true,
      lines: [
        { accountId: code['6000'], debit: '120.00' },
        { accountId: code['1000'], credit: '120.00' },
      ],
    });
    await createManualEntry(ctx, {
      date: new Date(2026, 11, 31),
      description: 'Regular entry',
      lines: [
        { accountId: code['6000'], debit: '1.00' },
        { accountId: code['1000'], credit: '1.00' },
      ],
    });
    const report = await getAdjustingEntries(ctx, { from: new Date(2026, 11, 1), to: new Date(2026, 11, 31, 23, 59) });
    expect(report.entries.map((e) => e.id)).toEqual([adj.id]);
    expect(report.totalDebit).toBe('120.00');
    expect(report.totalCredit).toBe('120.00');

    // Editing keeps the flag unless explicitly cleared.
    const d = await getEntry(ctx, adj.id);
    const edited = await updateEntry(ctx, adj.id, {
      date: d.date,
      description: 'Year-end depreciation (fixed)',
      lines: d.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
    });
    expect((await getEntry(ctx, edited.id)).isAdjusting).toBe(true);
    const after = await getAdjustingEntries(ctx, { from: new Date(2026, 11, 1) });
    expect(after.entries.map((e) => e.id)).toEqual([edited.id]);
  });
});

// ---------------------------------------------------------------------------
// B2 — tax lines
// ---------------------------------------------------------------------------

describe('income-tax line mapping', () => {
  it('assigns tax lines and groups accounts by line for the company form', async () => {
    await expect(updateAccount(ctx, code['4000'], { taxLine: 'SCHC:999' })).rejects.toThrow(/Unknown tax line/);
    await setIncomeTaxForm(ctx, 'SCHC');
    await updateAccount(ctx, code['4000'], { taxLine: 'SCHC:1' });
    await updateAccount(ctx, code['6000'], { taxLine: 'SCHC:8' });
    await updateAccount(ctx, code['6200'], { taxLine: '1120S:12' }); // another form
    const m = await getTaxLineMapping(ctx);
    expect(m.form).toBe('SCHC');
    expect(m.lines.find((l) => l.key === 'SCHC:1')!.accounts.map((a) => a.id)).toEqual([code['4000']]);
    expect(m.lines.find((l) => l.key === 'SCHC:8')!.accounts.map((a) => a.id)).toEqual([code['6000']]);
    expect(m.otherFormAccounts.map((a) => a.id)).toContain(code['6200']);
    expect(m.unassigned.map((a) => a.id)).toContain(code['1000']);
    expect(m.unassigned.map((a) => a.code)).not.toContain('9000'); // non-posting skipped
    await updateAccount(ctx, code['6000'], { taxLine: null });
    const m2 = await getTaxLineMapping(ctx);
    expect(m2.lines.find((l) => l.key === 'SCHC:8')!.accounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A3 — document numbers
// ---------------------------------------------------------------------------

describe('alphanumeric document numbers', () => {
  it('incrementAlnum follows QuickBooks (trailing digits, keeps width and prefix)', () => {
    expect(incrementAlnum('1001')).toBe('1002');
    expect(incrementAlnum('INV-0999')).toBe('INV-1000');
    expect(incrementAlnum('INV-99')).toBe('INV-100');
    expect(incrementAlnum('2026-07-15')).toBe('2026-07-16');
    expect(incrementAlnum('ABC')).toBe('ABC1');
    expect(incrementAlnum('')).toBe('1');
    expect(incrementAlnum('99999999999999999999')).toBe('100000000000000000000');
    expect(docNumberToInt('INV-1001')).toBe(1001);
    expect(docNumberToInt('ABC')).toBeNull();
    expect(docNumberToInt('99999999999')).toBeNull();
  });

  it('back-fills ref_number from the integer number for legacy writers', async () => {
    const [row] = await db
      .insert(estimates)
      .values({ companyId: ctx.companyId, customerId, estimateNumber: 7, date: new Date(2026, 4, 1) })
      .returning();
    expect(row.refNumber).toBe('7');
    expect(await nextDocNumber(ctx, 'estimate')).toBe('8');
  });

  it('uses the starting number, then increments the last number; refuses duplicates', async () => {
    await setStartingDocNumber(ctx, 'estimate', 'EST-0100');
    expect(await nextDocNumber(ctx, 'estimate')).toBe('EST-0100');
    const a = await allocateDocNumber(ctx, 'estimate');
    expect(a).toMatchObject({ refNumber: 'EST-0100', number: 100, duplicate: false });
    await db.insert(estimates).values({
      companyId: ctx.companyId,
      customerId,
      estimateNumber: a.number,
      refNumber: a.refNumber,
      date: new Date(2026, 4, 2),
    });
    expect(await nextDocNumber(ctx, 'estimate')).toBe('EST-0101');
    // User override + duplicate handling (case-insensitive).
    await expect(allocateDocNumber(ctx, 'estimate', 'est-0100')).rejects.toThrow(/already used/);
    const dup = await allocateDocNumber(ctx, 'estimate', 'EST-0100', { allowDuplicate: true });
    expect(dup.duplicate).toBe(true);
    const custom = await allocateDocNumber(ctx, 'estimate', 'SPECIAL');
    expect(custom.refNumber).toBe('SPECIAL');
    expect(custom.number).toBeGreaterThan(100); // no digits → MAX + 1
    await expect(assertUniqueDocNumber(ctx, 'invoice', 'EST-0100')).resolves.toEqual({ duplicate: false });
    // A starting number already used is refused; clearing it falls back to last + 1.
    await expect(setStartingDocNumber(ctx, 'estimate', 'EST-0100')).rejects.toThrow(/already used/);
    await setStartingDocNumber(ctx, 'estimate', null);
    const settings = await getDocNumberSettings(ctx);
    expect(settings.find((s) => s.docType === 'estimate')).toMatchObject({ startingNumber: null, nextNumber: 'EST-0101' });
    expect(settings.find((s) => s.docType === 'invoice')!.nextNumber).toBe('1');
  });

  it('document create paths take a typed number, auto-increment it and warn on duplicates', async () => {
    const line = [{ quantity: 1, rate: '10.00' }];
    const a = await createInvoice(ctx, { customerId, date: new Date(2026, 5, 1), refNumber: ' INV-1001 ', lines: line });
    expect(a.refNumber).toBe('INV-1001');
    expect(a.invoiceNumber).toBe(1001);
    // Blank = the last number with its trailing digits + 1 (QB).
    const b = await createInvoice(ctx, { customerId, date: new Date(2026, 5, 2), lines: line });
    expect(b.refNumber).toBe('INV-1002');
    // Duplicate (any case) is refused with a CONFLICT the form turns into a confirm prompt...
    await expect(
      createInvoice(ctx, { customerId, date: new Date(2026, 5, 3), refNumber: 'inv-1001', lines: line }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { duplicateDocNumber: true } });
    // ...and kept once the user confirms.
    const c = await createInvoice(ctx, {
      customerId,
      date: new Date(2026, 5, 3),
      refNumber: 'INV-1001',
      allowDuplicateNumber: true,
      lines: line,
    });
    expect(c.refNumber).toBe('INV-1001');
    // Each document type has its own sequence.
    const po = await createPurchaseOrder(ctx, {
      vendorId,
      date: new Date(2026, 5, 1),
      refNumber: 'PO-A7',
      lines: [{ accountId: code['6000'], quantity: '1', rate: '5.00' }],
    });
    expect(po.refNumber).toBe('PO-A7');
    expect(await nextDocNumber(ctx, 'purchase_order')).toBe('PO-A8');
  });
});
