/**
 * Feature round (team purchbank): changing a transaction after it was reconciled.
 *
 * QB: "The transaction you are editing has been reconciled. Changing it will make your next
 * reconciliation not balance. Change it anyway?" — the edit is saved after the warning, the
 * transaction stays reconciled at its new amount, and the change is listed on the Previous
 * Reconciliation Discrepancy report. Before this the edit was refused outright.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accountantCopies,
  accounts,
  journalEntries,
  journalEntryLines,
  reconciliationChanges,
  reconciliationItems,
  users,
  vendors,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createExpense, updateExpense } from './expenses';
import { createBill } from './bills';
import { payBills, updateBillPayment } from './billPayments';
import { createDeposit, updateDeposit } from './deposits';
import { createTransfer, updateTransfer } from './transfers';
import { createManualEntry, updateEntry } from './journal';
import { createBankAccount } from './bankAccounts';
import {
  completeReconciliation,
  getReconcileInfo,
  getReconciliationReport,
  listClearable,
  reconciliationDiscrepancies,
  startReconciliation,
  toggleCleared,
  undoLastReconciliation,
} from './reconcile';
import { COMPANY_BACKUP_TABLE_NAMES } from './backup';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { PATCH as expensePATCH } from '@/app/api/expenses/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-purchbank-reconciled-edits');
let db: DB;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to be refused').toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

/** Fund 1000 Checking with 5,000.00 on Mar 1. */
async function fund(accountId = acct['1000'], amount = '5000.00') {
  await createManualEntry(ctx, {
    date: d('2026-03-01'),
    description: 'Owner investment',
    lines: [
      { accountId, debit: amount },
      { accountId: acct['3000'], credit: amount },
    ],
  });
}

/** Reconcile `accountId` through Mar 31, clearing every line; returns the bank link and session id. */
async function reconcileAll(accountId: string, statementBalance: string) {
  const bank = await createBankAccount(ctx, { accountId, bankName: `Bank ${seq}`, accountNumber: `12345${seq}` });
  const recon = await startReconciliation(ctx, { bankAccountId: bank.id, statementDate: d('2026-03-31'), statementBalance });
  for (const l of await listClearable(ctx, bank.id, d('2026-03-31'), recon.id)) {
    await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
  }
  await completeReconciliation(ctx, recon.id);
  return { bank, reconId: recon.id };
}

async function writeCheck(amount: string, accountId = acct['6300']) {
  return createExpense(ctx, {
    payeeName: 'Landlord',
    date: d('2026-03-10'),
    method: 'check',
    reference: '101',
    paymentAccountId: acct['1000'],
    lines: [{ accountId, amount }],
  });
}

const checkInput = (amount: string, accountId = acct['6300'], extra: Record<string, unknown> = {}) => ({
  payeeName: 'Landlord',
  date: d('2026-03-10'),
  method: 'check' as const,
  reference: '101',
  paymentAccountId: acct['1000'],
  lines: [{ accountId, amount }],
  ...extra,
});

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'purchbank-recon@test.local', name: 'PB', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Purchbank reconciled ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort */
  }
});

describe('changing a reconciled check', () => {
  it("gives QB's warning (with a Change it anyway fix) instead of refusing outright", async () => {
    await fund();
    const chk = await writeCheck('200.00');
    await reconcileAll(acct['1000'], '4800.00');
    const err = await refusal(updateExpense(ctx, chk.id, checkInput('250.00')));
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/has been reconciled/);
    expect(err.message).toMatch(/Change it anyway\?/);
    expect((err.details as { reconciledEdit?: boolean }).reconciledEdit).toBe(true);
    expect(err.fixes?.some((f) => f.id === 'reconciled-edit-confirm')).toBe(true);
    // Nothing changed.
    const [row] = await db.select().from(reconciliationChanges).where(eq(reconciliationChanges.companyId, ctx.companyId));
    expect(row).toBeUndefined();
  });

  it('saves the change once confirmed: still reconciled, and the discrepancy shows in the reports', async () => {
    await fund();
    const chk = await writeCheck('200.00');
    const { bank, reconId } = await reconcileAll(acct['1000'], '4800.00');
    const saved = await updateExpense(ctx, chk.id, checkInput('250.00', acct['6300'], { allowReconciledEdit: true }));
    expect(saved.postedEntryId).not.toBe(chk.postedEntryId);

    // The new bank line is cleared in the same (completed) reconciliation.
    const [bankLine] = await db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, saved.postedEntryId!), eq(journalEntryLines.accountId, acct['1000'])));
    const [item] = await db.select().from(reconciliationItems).where(eq(reconciliationItems.journalEntryLineId, bankLine.id));
    expect(item?.reconciliationId).toBe(reconId);
    expect(item?.isCleared).toBe(true);

    // Next reconciliation: the beginning balance (4,800.00) no longer matches the reconciled
    // transactions (4,750.00) — the 50.00 difference is the discrepancy.
    const info = await getReconcileInfo(ctx, bank.id);
    expect(info.beginningBalance).toBe('4800.00');
    expect(info.recomputedBalance).toBe('4750.00');
    expect(info.discrepancy).toBe('50.00');

    // Previous Reconciliation Discrepancy report: one "Amount" change of -50.00 (and the voided old
    // entry is not listed again as a deleted transaction).
    const rows = await reconciliationDiscrepancies(ctx, bank.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changeType: 'amount', reconciledAmount: '-200.00', newAmount: '-250.00', amount: '-50.00' });
    expect(rows[0].journalEntryId).toBe(saved.postedEntryId);

    // The reconciliation report of that statement keeps its reconciled totals and lists the change.
    const report = await getReconciliationReport(ctx, reconId);
    expect(report.clearedBalance).toBe('4800.00');
    expect(report.difference).toBe('0.00');
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ changeType: 'amount', effect: '-50.00' });
    expect(report.discrepancies).toHaveLength(0);

    // The changed check is not offered again in the next reconciliation.
    const next = await startReconciliation(ctx, { bankAccountId: bank.id, statementDate: d('2026-04-30'), statementBalance: '4750.00' });
    const clearable = await listClearable(ctx, bank.id, d('2026-04-30'), next.id);
    expect(clearable.some((l) => l.journalEntryLineId === bankLine.id)).toBe(false);
  });

  it('a change that keeps the bank line (only the expense account) needs no confirmation', async () => {
    await fund();
    const chk = await writeCheck('200.00');
    const { bank } = await reconcileAll(acct['1000'], '4800.00');
    const saved = await updateExpense(ctx, chk.id, checkInput('200.00', acct['6400']));
    expect(saved.postedEntryId).not.toBe(chk.postedEntryId);
    const info = await getReconcileInfo(ctx, bank.id);
    expect(info.discrepancy).toBe('0.00');
    expect(await reconciliationDiscrepancies(ctx, bank.id)).toHaveLength(0);
  });

  it('moving the check to another bank account takes it out of the reconciliation (a "Deleted" change)', async () => {
    await fund();
    await fund(acct['1010'], '1000.00');
    const chk = await writeCheck('200.00');
    const { bank } = await reconcileAll(acct['1000'], '4800.00');
    await updateExpense(ctx, chk.id, { ...checkInput('200.00', acct['6300'], { allowReconciledEdit: true }), paymentAccountId: acct['1010'] });
    const rows = await reconciliationDiscrepancies(ctx, bank.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changeType: 'removed', reconciledAmount: '-200.00', amount: '200.00' });
    expect((await getReconcileInfo(ctx, bank.id)).discrepancy).toBe('-200.00');
  });

  it('a change made and then rolled back (a later refusal in the same save) leaves nothing behind', async () => {
    await fund();
    const chk = await writeCheck('200.00');
    await reconcileAll(acct['1000'], '4800.00');
    // An inactive / unknown line account fails after the reconciled check has been prepared.
    await refusal(updateExpense(ctx, chk.id, checkInput('250.00', '00000000-0000-4000-8000-000000000000', { allowReconciledEdit: true })));
    const rows = await db.select().from(reconciliationChanges).where(eq(reconciliationChanges.companyId, ctx.companyId));
    expect(rows).toHaveLength(0);
  });

  it('an undone reconciliation no longer lists the change', async () => {
    await fund();
    const chk = await writeCheck('200.00');
    const { bank } = await reconcileAll(acct['1000'], '4800.00');
    await updateExpense(ctx, chk.id, checkInput('250.00', acct['6300'], { allowReconciledEdit: true }));
    await undoLastReconciliation(ctx, bank.id);
    expect(await reconciliationDiscrepancies(ctx, bank.id)).toHaveLength(0);
  });

  it('PATCH /api/expenses/:id passes the confirmation through', async () => {
    await fund();
    const chk = await writeCheck('200.00');
    await reconcileAll(acct['1000'], '4800.00');
    const patch = (body: Record<string, unknown>) =>
      expensePATCH(
        new Request(`http://localhost/api/expenses/${chk.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }) as never,
        { params: Promise.resolve({ id: chk.id }) },
      );
    const base = { payeeName: 'Landlord', date: '2026-03-10', method: 'check', reference: '101', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6300'], amount: '275.00' }] };
    const refused = await patch(base);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { details?: { reconciledEdit?: boolean } };
    expect(body.details?.reconciledEdit).toBe(true);
    const ok = await patch({ ...base, allowReconciledEdit: true });
    expect(ok.status).toBe(200);
  });

  it("is refused in an Accountant's Copy (the change could not be sent back to the client)", async () => {
    await fund();
    const chk = await writeCheck('200.00');
    await reconcileAll(acct['1000'], '4800.00');
    await db.insert(accountantCopies).values({
      companyId: ctx.companyId,
      side: 'accountant',
      status: 'open',
      dividingDate: '2026-12-31',
      fileToken: `tok-${seq}`,
    });
    const err = await refusal(updateExpense(ctx, chk.id, checkInput('250.00', acct['6300'], { allowReconciledEdit: true })));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toMatch(/Accountant's Copy/);
  });
});

describe('other reconciled transactions', () => {
  it('deposit: the amount changes after the warning', async () => {
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: d('2026-03-05'),
      extraLines: [{ accountId: acct['3000'], amount: '300.00' }],
    });
    const { bank } = await reconcileAll(acct['1000'], '300.00');
    const input = { depositAccountId: acct['1000'], date: d('2026-03-05'), extraLines: [{ accountId: acct['3000'], amount: '330.00' }] };
    expect((await refusal(updateDeposit(ctx, dep.id, input))).message).toMatch(/has been reconciled/);
    await updateDeposit(ctx, dep.id, { ...input, allowReconciledEdit: true });
    const rows = await reconciliationDiscrepancies(ctx, bank.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changeType: 'amount', reconciledAmount: '300.00', newAmount: '330.00', amount: '30.00' });
  });

  it('transfer: the amount changes after the warning', async () => {
    await fund();
    const t = await createTransfer(ctx, { date: d('2026-03-07'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '100.00' });
    const { bank } = await reconcileAll(acct['1000'], '4900.00');
    const input = { date: d('2026-03-07'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '150.00' };
    expect((await refusal(updateTransfer(ctx, t.id, input))).message).toMatch(/has been reconciled/);
    await updateTransfer(ctx, t.id, { ...input, allowReconciledEdit: true });
    expect((await reconciliationDiscrepancies(ctx, bank.id))[0]).toMatchObject({ changeType: 'amount', amount: '-50.00' });
  });

  it('bill payment check: the amount changes after the warning', async () => {
    await fund();
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: `Supplier ${seq}` }).returning();
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-03-02'), lines: [{ accountId: acct['6300'], amount: '400.00' }] });
    const pay = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-03-12'),
      method: 'check',
      reference: '2001',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '300.00' }],
    });
    const { bank } = await reconcileAll(acct['1000'], '4700.00');
    const input = {
      vendorId: v.id,
      date: d('2026-03-12'),
      method: 'check' as const,
      reference: '2001',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '400.00' }],
    };
    expect((await refusal(updateBillPayment(ctx, pay.id, input))).message).toMatch(/has been reconciled/);
    await updateBillPayment(ctx, pay.id, { ...input, allowReconciledEdit: true });
    expect((await reconciliationDiscrepancies(ctx, bank.id))[0]).toMatchObject({ changeType: 'amount', reconciledAmount: '-300.00', amount: '-100.00' });
  });

  it('General Journal entry: the amount changes after the warning', async () => {
    const je = await createManualEntry(ctx, {
      date: d('2026-03-03'),
      description: 'Loan proceeds',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },
        { accountId: acct['3000'], credit: '1000.00' },
      ],
    });
    const { bank } = await reconcileAll(acct['1000'], '1000.00');
    const input = {
      date: d('2026-03-03'),
      description: 'Loan proceeds',
      lines: [
        { accountId: acct['1000'], debit: '1200.00' },
        { accountId: acct['3000'], credit: '1200.00' },
      ],
    };
    expect((await refusal(updateEntry(ctx, je.id, input))).message).toMatch(/has been reconciled/);
    const replaced = await updateEntry(ctx, je.id, { ...input, allowReconciledEdit: true });
    const rows = await reconciliationDiscrepancies(ctx, bank.id);
    expect(rows[0]).toMatchObject({ changeType: 'amount', reconciledAmount: '1000.00', newAmount: '1200.00', amount: '200.00' });
    expect(rows[0].journalEntryId).toBe(replaced.id);
    const [old] = await db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, je.id));
    expect(old.status).toBe('void');
  });
});

describe('company file portability', () => {
  it('a per-company backup carries the reconciliation changes', () => {
    expect(COMPANY_BACKUP_TABLE_NAMES).toContain('reconciliation_changes');
  });
});
