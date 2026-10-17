/**
 * Register entry (QB "Use Register" blank row): a transaction typed into any account's register
 * is saved as the document QB would make, through that document's own service, and lands in
 * both accounts' registers.
 *
 * Boots a throwaway PGlite company with a chart covering every register class, then enters rows
 * from different registers and checks the document kind, the balances and the register rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, vendors, customers, expenses, deposits, transfers, journalEntryLines } from '@/lib/db/schema';
import { unionRoles } from '@/lib/permissions/model';
import { planRegisterEntry, registerEntryBlockedReason, type PlanAccount } from '@/lib/registerEntryPlan';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { accountRegister, listRegisterAccounts } from './journal';
import { enterRegisterTransaction } from './registerEntry';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-register-entry');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let vendorId: string;
let customerId: string;

async function balanceOf(accountId: string): Promise<string> {
  const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, accountId));
  return row.balance;
}

const day = (s: string) => new Date(`${s}T12:00:00`);

describe('planRegisterEntry (pure)', () => {
  const a = (id: string, type: string, subtype: string, extra: Partial<PlanAccount> = {}): PlanAccount => ({ id, type, subtype, ...extra });
  const checking = a('chk', 'asset', 'checking');
  const savings = a('sav', 'asset', 'savings');
  const visa = a('visa', 'liability', 'credit_card');
  const supplies = a('sup', 'expense', 'operating_expenses');
  const equity = a('eq', 'equity', 'owners_equity');
  const loan = a('loan', 'liability', 'long_term_liability');
  const prepaid = a('pre', 'asset', 'other_current_asset');
  const uf = a('uf', 'asset', 'undeposited_funds');

  it.each([
    ['bank payment to an expense is a check on that bank', checking, supplies, 'decrease', { kind: 'check', paymentAccountId: 'chk', lineAccountId: 'sup' }],
    ['bank deposit from equity is a deposit', checking, equity, 'increase', { kind: 'deposit', debitAccountId: 'chk', lineAccountId: 'eq' }],
    ['bank to bank is a transfer', checking, savings, 'decrease', { kind: 'transfer', debitAccountId: 'sav', creditAccountId: 'chk' }],
    ['card charge to an expense', visa, supplies, 'increase', { kind: 'card_charge', paymentAccountId: 'visa', lineAccountId: 'sup' }],
    ['card paid from the bank is a check on the bank', visa, checking, 'decrease', { kind: 'check', paymentAccountId: 'chk', lineAccountId: 'visa' }],
    ['card refund to an expense is a card credit', visa, supplies, 'decrease', { kind: 'card_credit', paymentAccountId: 'visa', lineAccountId: 'sup' }],
    ['loan register paid from the bank is a check', loan, checking, 'decrease', { kind: 'check', paymentAccountId: 'chk', lineAccountId: 'loan' }],
    ['expense register paid by card is a card charge', supplies, visa, 'increase', { kind: 'card_charge', paymentAccountId: 'visa', lineAccountId: 'sup' }],
    ['prepaid to loan is a journal entry', prepaid, loan, 'increase', { kind: 'journal', debitAccountId: 'pre', creditAccountId: 'loan' }],
  ] as const)('%s', (_label, register, other, side, expected) => {
    expect(planRegisterEntry(register, other, side)).toMatchObject({ ok: true, ...expected });
  });

  it('refuses what belongs on another form', () => {
    expect(planRegisterEntry(checking, checking, 'decrease').ok).toBe(false);
    expect(planRegisterEntry(checking, a('ar', 'asset', 'accounts_receivable'), 'increase').ok).toBe(false);
    expect(planRegisterEntry(a('ap', 'liability', 'accounts_payable'), checking, 'decrease').ok).toBe(false);
    expect(planRegisterEntry(checking, a('inv', 'asset', 'inventory'), 'decrease').ok).toBe(false);
    expect(planRegisterEntry(checking, uf, 'increase')).toMatchObject({ ok: false, message: expect.stringMatching(/Make Deposits/) });
    expect(planRegisterEntry(checking, a('eur', 'asset', 'savings', { currency: 'EUR' }), 'decrease').ok).toBe(false);
    expect(planRegisterEntry(checking, a('old', 'expense', 'operating_expenses', { isActive: false }), 'decrease').ok).toBe(false);
    expect(registerEntryBlockedReason({ subtype: 'accounts_receivable' })).toMatch(/invoices/);
    expect(registerEntryBlockedReason({ subtype: 'checking' })).toBeNull();
  });
});

describe('enterRegisterTransaction', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'reg-entry@test.local', name: 'Reg Entry', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Register Entry Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1100', 'Savings', 'asset', 'savings'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['1300', 'Prepaid Insurance', 'asset', 'other_current_asset'],
      ['2100', 'Visa Card', 'liability', 'credit_card'],
      ['2500', 'Truck Loan', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6000', 'Office Supplies', 'expense', 'operating_expenses'],
      ['9000', 'Estimates', 'asset', 'non_posting'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    [{ id: vendorId }] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Office Depot' }).returning();
    [{ id: customerId }] = await db.insert(customers).values({ companyId: company.id, displayName: 'Jane Customer' }).returning();
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('every posting account gets a register; non-posting accounts do not', async () => {
    const codes = (await listRegisterAccounts(ctx)).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['1000', '2100', '2500', '3000', '4000', '6000']));
    expect(codes).not.toContain('9000');
  });

  it('owner money typed into the checking register is a deposit', async () => {
    const r = await enterRegisterTransaction(ctx, acct['1000'], {
      date: day('2026-01-02'),
      payee: 'Owner',
      otherAccountId: acct['3000'],
      side: 'increase',
      amount: '5000',
    });
    expect(r.kind).toBe('deposit');
    expect(await db.select().from(deposits).where(eq(deposits.id, r.id))).toHaveLength(1);
    expect(Number(await balanceOf(acct['1000']))).toBe(5000);
    expect(Number(await balanceOf(acct['3000']))).toBe(5000);
  });

  it('a payment to a known vendor is a numbered check linked to the vendor', async () => {
    const r = await enterRegisterTransaction(ctx, acct['1000'], {
      date: day('2026-01-05'),
      number: '1001',
      payee: 'office depot',
      otherAccountId: acct['6000'],
      memo: 'paper',
      side: 'decrease',
      amount: '120.50',
    });
    expect(r.kind).toBe('check');
    const [exp] = await db.select().from(expenses).where(eq(expenses.id, r.id));
    expect(exp).toMatchObject({ method: 'check', reference: '1001', vendorId });
    expect(Number(await balanceOf(acct['1000']))).toBe(4879.5);
    expect(Number(await balanceOf(acct['6000']))).toBe(120.5);

    const reg = await accountRegister(ctx, acct['1000']);
    const row = reg.rows.find((x) => x.reference === '1001')!;
    expect(row.credit).toBe('120.50');
    expect(row.runningBalance).toBe('4879.50');
    // Account column: the other side of the check.
    expect(row.otherAccount).toEqual({ id: acct['6000'], label: '6000 · Office Supplies' });
  });

  it('a repeated check number is refused unless confirmed', async () => {
    const input = { date: day('2026-01-06'), number: '1001', payee: 'Corner Store', otherAccountId: acct['6000'], side: 'decrease' as const, amount: '10' };
    await expect(enterRegisterTransaction(ctx, acct['1000'], { ...input, checkDuplicateNumber: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    const ok = await enterRegisterTransaction(ctx, acct['1000'], { ...input, checkDuplicateNumber: false });
    expect(ok.kind).toBe('check');
    const [exp] = await db.select().from(expenses).where(eq(expenses.id, ok.id));
    expect(exp).toMatchObject({ vendorId: null, payeeName: 'Corner Store' });
  });

  it('checking to savings is a transfer', async () => {
    const r = await enterRegisterTransaction(ctx, acct['1000'], { date: day('2026-01-07'), otherAccountId: acct['1100'], side: 'decrease', amount: '1000' });
    expect(r.kind).toBe('transfer');
    expect(await db.select().from(transfers).where(eq(transfers.id, r.id))).toHaveLength(1);
    expect(Number(await balanceOf(acct['1100']))).toBe(1000);
  });

  it('a charge typed into the card register is a card charge; a refund is a card credit', async () => {
    const charge = await enterRegisterTransaction(ctx, acct['2100'], { date: day('2026-01-08'), payee: 'Office Depot', otherAccountId: acct['6000'], side: 'increase', amount: '75' });
    expect(charge.kind).toBe('card_charge');
    expect(Number(await balanceOf(acct['2100']))).toBe(75);
    const credit = await enterRegisterTransaction(ctx, acct['2100'], { date: day('2026-01-09'), payee: 'Office Depot', otherAccountId: acct['6000'], side: 'decrease', amount: '25' });
    expect(credit.kind).toBe('card_credit');
    expect(Number(await balanceOf(acct['2100']))).toBe(50);
  });

  it('paying the card from its own register writes a check on the bank', async () => {
    const before = Number(await balanceOf(acct['1000']));
    const r = await enterRegisterTransaction(ctx, acct['2100'], { date: day('2026-01-10'), payee: 'Visa', otherAccountId: acct['1000'], side: 'decrease', amount: '50' });
    expect(r.kind).toBe('check');
    const [exp] = await db.select().from(expenses).where(eq(expenses.id, r.id));
    expect(exp.paymentAccountId).toBe(acct['1000']);
    expect(Number(await balanceOf(acct['2100']))).toBe(0);
    expect(Number(await balanceOf(acct['1000']))).toBe(before - 50);
  });

  it('two non-bank accounts make a journal entry carrying the picked name', async () => {
    const r = await enterRegisterTransaction(ctx, acct['1300'], {
      date: day('2026-01-11'),
      number: 'JE-7',
      name: { type: 'customer', id: customerId },
      otherAccountId: acct['2500'],
      memo: 'insurance financed',
      side: 'increase',
      amount: '600',
    });
    expect(r.kind).toBe('journal');
    expect(Number(await balanceOf(acct['1300']))).toBe(600);
    expect(Number(await balanceOf(acct['2500']))).toBe(600);
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, r.id));
    const loanLine = lines.find((l) => l.accountId === acct['2500'])!;
    expect(loanLine).toMatchObject({ entityType: 'customer', entityId: customerId });
    const reg = await accountRegister(ctx, acct['1300']);
    expect(reg.rows.at(-1)).toMatchObject({ reference: 'JE-7', description: 'Jane Customer', otherAccount: { label: '2500 · Truck Loan' } });
  });

  it('refuses bad input before anything is saved', async () => {
    const base = { date: day('2026-01-12'), payee: 'X', side: 'decrease' as const, amount: '10' };
    await expect(enterRegisterTransaction(ctx, acct['1000'], { ...base, otherAccountId: acct['9000'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(enterRegisterTransaction(ctx, acct['1000'], { ...base, otherAccountId: acct['6000'], amount: '0' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(enterRegisterTransaction(ctx, acct['1000'], { ...base, otherAccountId: acct['6000'], payee: '' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      enterRegisterTransaction(ctx, acct['1000'], { ...base, otherAccountId: acct['6000'], name: { type: 'vendor', id: '00000000-0000-4000-8000-000000000000' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an account from another company is not found', async () => {
    const [u2] = await db.insert(users).values({ email: 'other-co@test.local', name: 'Other', passwordHash: 'x' }).returning();
    const [c2] = await db.insert(companies).values({ name: 'Other Co', ownerId: u2.id }).returning();
    const otherCtx = { db, companyId: c2.id, userId: u2.id };
    await expect(
      enterRegisterTransaction(otherCtx, acct['1000'], { date: day('2026-01-12'), payee: 'X', otherAccountId: acct['6000'], side: 'decrease', amount: '1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a journal entry needs Accounting permission; a check needs only Banking', async () => {
    const bankingOnly = unionRoles([{ key: 'bank_clerk', label: 'Bank clerk', builtin: false, permissions: { banking: ['full'] }, flags: {} } as never]);
    const clerk = { ...ctx, access: bankingOnly };
    await expect(
      enterRegisterTransaction(clerk, acct['1300'], { date: day('2026-01-13'), otherAccountId: acct['2500'], side: 'increase', amount: '5' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const check = await enterRegisterTransaction(clerk, acct['1000'], { date: day('2026-01-13'), payee: 'Corner Store', otherAccountId: acct['6000'], side: 'decrease', amount: '5' });
    expect(check.kind).toBe('check');
  });
});
