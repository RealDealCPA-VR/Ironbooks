/**
 * P1 controls — closing date covers EVERY change to a closed-period transaction (QB parity).
 * Ledger-neutral edits (memo, payee, number, customer:job, line description) of posted checks,
 * deposits, transfers, vendor credits and bill payments keep their journal entry, so the
 * void/repost period check never ran. They now need the closing-date password and are listed
 * on the Closing Date Exception report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { postJournalEntry } from './posting';
import { createExpense, updateExpense } from './expenses';
import { createVendorCredit, updateVendorCredit } from './vendorCredits';
import { createTransfer, updateTransfer } from './transfers';
import { createDeposit, updateDeposit } from './deposits';
import { createBill } from './bills';
import { payBills, updateBillPayment } from './billPayments';
import { setClosingDate } from './company';
import { closingDateExceptionReport } from './accountant/auditReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-closed-period-edits');
let db: DB;
let ctx: ServiceContext;
let over: ServiceContext;
const acct: Record<string, string> = {};
let vendorId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('closing date blocks ledger-neutral edits of closed-period transactions', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'cpe@test.local', name: 'CPE', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Closed Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    over = { ...ctx, closingDateOverride: true };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Savings', 'asset', 'savings'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Depot' }).returning())[0].id;
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '10000.00' },
        { accountId: acct['3000'], credit: '10000.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; next run wipes it. */
    }
  });

  it('checks, vendor credits, transfers, deposits and bill payments need the password for memo-only edits', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: d('2026-01-10'),
      method: 'check',
      reference: '101',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '20.00' }],
    });
    const vc = await createVendorCredit(ctx, { vendorId, date: d('2026-01-11'), lines: [{ accountId: acct['6300'], amount: '5.00' }] });
    const tr = await createTransfer(ctx, { date: d('2026-01-12'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '30.00' });
    const dep = await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-01-13'), extraLines: [{ accountId: acct['3000'], amount: '40.00' }] });
    const bill = await createBill(ctx, { vendorId, date: d('2026-01-14'), lines: [{ accountId: acct['6300'], amount: '50.00' }] });
    const bp = await payBills(ctx, {
      vendorId,
      date: d('2026-01-15'),
      method: 'check',
      reference: '102',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '50.00' }],
    });

    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'close-pw' } as never);

    const expEdit = (c: ServiceContext) =>
      updateExpense(c, exp.id, {
        vendorId,
        date: d('2026-01-10'),
        method: 'check',
        reference: '101',
        paymentAccountId: acct['1000'],
        memo: 'new memo',
        lines: [{ accountId: acct['6300'], amount: '20.00', description: 'paper' }],
      });
    const vcEdit = (c: ServiceContext) =>
      updateVendorCredit(c, vc.id, { vendorId, date: d('2026-01-11'), memo: 'changed', lines: [{ accountId: acct['6300'], amount: '5.00' }] } as never);
    const trEdit = (c: ServiceContext) =>
      updateTransfer(c, tr.id, { date: d('2026-01-12'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '30.00', memo: 'renamed' });
    const depEdit = (c: ServiceContext) =>
      updateDeposit(c, dep.id, { depositAccountId: acct['1000'], date: d('2026-01-13'), memo: 'renamed', extraLines: [{ accountId: acct['3000'], amount: '40.00' }] });
    const bpEdit = (c: ServiceContext) =>
      updateBillPayment(c, bp.id, {
        vendorId,
        date: d('2026-01-15'),
        method: 'check',
        reference: '102A',
        paymentAccountId: acct['1000'],
        applications: [{ billId: bill.id, amountApplied: '50.00' }],
      });

    for (const edit of [expEdit, vcEdit, trEdit, depEdit, bpEdit]) {
      await expect(edit(ctx)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    }

    // With the closing-date password: allowed, entry kept, and each one is on the exception report.
    const e2 = await expEdit(over);
    expect(e2.memo).toBe('new memo');
    expect(e2.postedEntryId).toBe(exp.postedEntryId);
    const v2 = await vcEdit(over);
    expect(v2.postedEntryId).toBe(vc.postedEntryId);
    const t2 = await trEdit(over);
    expect(t2.postedEntryId).toBe(tr.postedEntryId);
    await depEdit(over);
    const b2 = await bpEdit(over);
    expect(b2.reference).toBe('102A');

    const report = await closingDateExceptionReport(ctx);
    const edits = report.rows.filter((r) => r.source === 'override' && r.operation === 'edit');
    const ids = new Set(edits.map((r) => r.entryId));
    for (const id of [exp.postedEntryId, vc.postedEntryId, tr.postedEntryId, dep.postedEntryId, bp.postedEntryId]) {
      expect(ids.has(id as string)).toBe(true);
    }
    expect(edits.every((r) => r.closingDate === '2026-01-31')).toBe(true);

    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('memo-only edits after the closing date are unaffected and not reported', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: d('2026-02-10'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '7.00' }],
    });
    const out = await updateExpense(ctx, exp.id, {
      vendorId,
      date: d('2026-02-10'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      memo: 'open period',
      lines: [{ accountId: acct['6300'], amount: '7.00' }],
    });
    expect(out.memo).toBe('open period');
    const report = await closingDateExceptionReport(ctx);
    expect(report.rows.some((r) => r.entryId === exp.postedEntryId)).toBe(false);
  });
});
