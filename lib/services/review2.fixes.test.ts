/**
 * Round-2 review fixes (core accounting):
 *  - "add automatically" bank rules never double-book and never redo an Unmatch (autoPostGuard);
 *  - IIF-imported history counts as already-in-the-books for automatic posting;
 *  - a check written weeks before it cleared stops an automatic post of its bank line;
 *  - the AI's suggestions use the bank rules as they are now (a rule made after the import);
 *  - a one-account bank file for another account is refused;
 *  - day-first CSV dates are recognized from the whole column (undecidable stays month-first);
 *  - a deposit holding a bounced check cannot drop it or move;
 *  - "apply later" refuses fractions of a cent;
 *  - an edit of a foreign-currency journal entry keeps its foreign amounts and booked rate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, bankTransactions, customers, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { categorize, unmatch } from './bankCategorize';
import { runAutoRules } from './bankSuggest';
import { createBankRule } from './bankRules';
import { suggestBankCategories } from './aiCategorizer';
import { postJournalEntry } from './posting';
import { detectNumericDateOrder, parseCSV, parseOFX } from './import';
import { createInvoice } from './invoices';
import { applyPayment, receivePayment, recordBouncedCheck } from './payments';
import { createDeposit, updateDeposit } from './deposits';
import { bookedRate, keepForeignAmounts } from './journal';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-fixes');
let db: DB;
let ctx: ServiceContext;
let bankId: string;
let checkingId: string;
let expenseId: string;
let seq = 0;

async function line(date: string, amount: string, description = 'SHELL OIL 57444') {
  seq += 1;
  const [row] = await db
    .insert(bankTransactions)
    .values({ companyId: ctx.companyId, bankAccountId: bankId, date: new Date(`${date}T12:00:00Z`), description, amount, fitId: `r2-${seq}` })
    .returning();
  return row.id;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'review2@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review Two Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  checkingId = all.find((a) => a.subtype === 'checking' && !/undeposited/i.test(a.name))!.id;
  expenseId = all.find((a) => a.type === 'expense' && a.isActive)!.id;
  bankId = (await db.insert(bankAccounts).values({ companyId: company.id, accountId: checkingId, bankName: 'Bank', accountNumber: '000123456789' }).returning())[0].id;
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('automatic bank rules', () => {
  it('post once, and never again after Unmatch', async () => {
    await createBankRule(ctx, { name: 'Shell fuel', matchField: 'description', matchOperator: 'contains', matchValue: 'SHELL', setAccountId: expenseId, mode: 'auto' });
    const id = await line('2026-06-05', '-41.10');
    expect((await runAutoRules(ctx, bankId)).applied.map((a) => a.bankTransactionId)).toContain(id);
    await unmatch(ctx, id);
    const again = await runAutoRules(ctx, bankId);
    expect(again.applied.map((a) => a.bankTransactionId)).not.toContain(id);
    expect(again.skipped.find((s) => s.bankTransactionId === id)?.reason).toMatch(/undone/);
  });

  it('leave a line that a check written weeks earlier may already cover', async () => {
    await postJournalEntry(ctx, {
      date: new Date('2026-06-01T12:00:00Z'),
      description: 'Check 1201 Shell',
      lines: [
        { accountId: expenseId, debit: '63.40', credit: null },
        { accountId: checkingId, debit: null, credit: '63.40' },
      ],
    });
    const id = await line('2026-07-08', '-63.40');
    const r = await runAutoRules(ctx, bankId);
    expect(r.applied.map((a) => a.bankTransactionId)).not.toContain(id);
    expect(r.skipped.find((s) => s.bankTransactionId === id)?.reason).toMatch(/match/i);
  });

  it('leave a line dated within IIF-imported QuickBooks history', async () => {
    await postJournalEntry(ctx, {
      date: new Date('2026-08-31T12:00:00Z'),
      description: 'Imported from QuickBooks (IIF)',
      sourceRef: 'iif:TRNS:77:2026-08-31:5.00',
      lines: [
        { accountId: expenseId, debit: '5.00', credit: null },
        { accountId: checkingId, debit: null, credit: '5.00' },
      ],
    });
    const id = await line('2026-08-20', '-39.95');
    const r = await runAutoRules(ctx, bankId);
    expect(r.skipped.find((s) => s.bankTransactionId === id)?.reason).toMatch(/QuickBooks history/);
  });
});

describe('AI suggestions use the live rules', () => {
  it('a rule made after the import is the suggestion', async () => {
    const id = await line('2026-09-10', '-12.00', 'ACME WIDGETS 99');
    await createBankRule(ctx, { name: 'Acme', matchField: 'description', matchOperator: 'contains', matchValue: 'ACME', setAccountId: expenseId, mode: 'suggest' });
    const { suggestions } = await suggestBankCategories(ctx, bankId);
    expect(suggestions.find((s) => s.bankTransactionId === id)).toMatchObject({ source: 'rule', accountId: expenseId });
  });
});

describe('bank files', () => {
  const ofx = (acct: string) =>
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>\n<BANKMSGSRSV1>\n<STMTTRNRS>\n<TRNUID>1\n<STMTRS>\n<CURDEF>USD\n<BANKACCTFROM>\n<ACCTID>${acct}\n</BANKACCTFROM>\n<BANKTRANLIST>\n<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>20260305\n<TRNAMT>-5.00\n<FITID>x1\n<NAME>TEST\n</STMTTRN>\n</BANKTRANLIST>\n</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>`;

  it('a one-account file for another account is refused; the right one (or its last 4) is fine', () => {
    expect(() => parseOFX(ofx('999988887777'), '000123456789')).toThrow(/not this bank account/);
    expect(parseOFX(ofx('000123456789'), '000123456789')).toHaveLength(1);
    expect(parseOFX(ofx('XXXXXXXX6789'), '000123456789')).toHaveLength(1);
    expect(parseOFX(ofx('999988887777'), null)).toHaveLength(1);
  });

  it('CSV dates: the whole column decides day-first or month-first', () => {
    expect(detectNumericDateOrder(['03/04/2026', '25/04/2026'])).toBe('DD/MM/YYYY');
    expect(detectNumericDateOrder(['03/04/2026', '04/25/2026'])).toBe('MM/DD/YYYY');
    expect(detectNumericDateOrder(['2026-04-03'])).toBeNull();
    expect(detectNumericDateOrder(['03/04/2026', '05/06/2026'])).toBe('MM/DD/YYYY');
    const rows = parseCSV('Date,Description,Amount\n03/04/2026,A,-1.00\n25/04/2026,B,-2.00\n', { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' } as never);
    expect(rows[0].date.toISOString().slice(0, 10)).toBe('2026-04-03');
  });
});

describe('payments and deposits', () => {
  it('a deposit holding a bounced check keeps it; apply-later refuses fractions of a cent', async () => {
    const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Bounce Customer' }).returning();
    const all = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const uf = all.find((a) => /undeposited/i.test(a.name))!.id;
    const inv = await createInvoice(ctx, { customerId: cust.id, date: new Date('2026-05-01T12:00:00Z'), lines: [{ description: 'Work', quantity: 1, rate: 500, taxable: false }] } as never);
    const inv2 = await createInvoice(ctx, { customerId: cust.id, date: new Date('2026-05-01T12:00:00Z'), lines: [{ description: 'More', quantity: 1, rate: 50, taxable: false }] } as never);
    const p1 = await receivePayment(ctx, { customerId: cust.id, date: new Date('2026-05-02T12:00:00Z'), method: 'check', reference: 'C1', amount: 500, depositAccountId: uf, applications: [{ invoiceId: inv.id, amountApplied: 500 }] } as never);
    const p2 = await receivePayment(ctx, { customerId: cust.id, date: new Date('2026-05-02T12:00:00Z'), method: 'cash', amount: 100, depositAccountId: uf, applications: [] } as never);
    const dep = await createDeposit(ctx, { depositAccountId: checkingId, date: new Date('2026-05-03T12:00:00Z'), paymentIds: [p1.payment.id, p2.payment.id] });
    await recordBouncedCheck(ctx, { paymentId: p1.payment.id, date: new Date('2026-05-10T12:00:00Z') });
    await expect(
      updateDeposit(ctx, dep.id, { depositAccountId: checkingId, date: new Date('2026-05-03T12:00:00Z'), paymentIds: [p2.payment.id] }),
    ).rejects.toThrow(/bounced/);
    await expect(applyPayment(ctx, { paymentId: p2.payment.id, applications: [{ invoiceId: inv2.id, amountApplied: '10.005' }] } as never)).rejects.toThrow(/dollars and cents/);
  });
});

describe('foreign-currency journal edits', () => {
  it('unchanged foreign lines keep their foreign amount; the booked rate is reused', () => {
    const old = [
      { accountId: 'exp', debit: '110.00', credit: null, currency: null, foreignAmount: null, exchangeRate: null },
      { accountId: 'eur-bank', debit: null, credit: '110.00', currency: 'EUR', foreignAmount: '100.00', exchangeRate: '1.10000000' },
    ];
    const next = keepForeignAmounts(old, [
      { accountId: 'exp', debit: '110', credit: null, classId: 'new-class' },
      { accountId: 'eur-bank', debit: null, credit: 110 },
    ]);
    expect(next[1].foreignAmount).toBe('100.00');
    expect(next[0].foreignAmount).toBeUndefined();
    expect(bookedRate(old)).toEqual({ currency: 'EUR', exchangeRate: '1.10000000' });
  });
});
