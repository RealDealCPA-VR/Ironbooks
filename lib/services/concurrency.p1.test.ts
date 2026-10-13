/**
 * P1 controls — record locking extended from 6 record types to every editable transaction,
 * employees and accounts (QB Enterprise "This record was changed by another user").
 *
 *  - Two users open the same check / transfer / deposit / vendor credit / estimate / PO / sales
 *    receipt / employee / account; the second save is refused with 409 naming who saved first,
 *    and nothing it would have written lands.
 *  - The 0046 version trigger moves updated_at on ANY change (e.g. a void through another path),
 *    so an open copy goes stale even when the change didn't come through withVersionCheck.
 *  - Accounts: postings change the cached balance but must NOT make an open account form stale.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers,
  vendors,
  accounts,
  expenses,
  transfers,
  deposits,
  vendorCredits,
  estimates,
  purchaseOrders,
  salesReceipts,
  employees,
} from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount, updateAccount } from './accounts';
import { postJournalEntry } from './posting';
import { createExpense, updateExpense, voidExpense } from './expenses';
import { createTransfer, updateTransfer } from './transfers';
import { createDeposit, updateDeposit } from './deposits';
import { createVendorCredit, updateVendorCredit } from './vendorCredits';
import { createEstimate, updateEstimateStatus } from './estimates';
import { createPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';
import { createSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createEmployee, updateEmployee } from './payroll';
import { trialBalance } from './reports';
import { VERSIONED_ENTITIES, versionField, withVersionCheck, type VersionedEntity } from './concurrency';
import { VERSIONED_RESOURCES } from '@/lib/client';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency-p1');
let db: DB;
let alice: ServiceContext;
let bob: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

const TABLE: Partial<Record<VersionedEntity, unknown>> = {
  expense: expenses,
  transfer: transfers,
  deposit: deposits,
  vendor_credit: vendorCredits,
  estimate: estimates,
  purchase_order: purchaseOrders,
  sales_receipt: salesReceipts,
  employee: employees,
  account: accounts,
};

async function version(entity: VersionedEntity, id: string): Promise<string> {
  const t = TABLE[entity] as typeof customers;
  const col = (t as unknown as Record<string, typeof customers.updatedAt>)[versionField(entity)];
  const [row] = await db.select({ v: col }).from(t).where(eq(t.id, id));
  return row.v.toISOString();
}

/** Alice and Bob both open `id`; Alice saves; Bob's save from the stale copy must be refused. */
async function raceOn(
  entity: VersionedEntity,
  id: string,
  aliceSave: (c: ServiceContext) => Promise<unknown>,
  bobSave: (c: ServiceContext) => Promise<unknown>,
) {
  const loaded = await version(entity, id);
  await withVersionCheck(alice, entity, id, loaded, aliceSave);
  const err = (await withVersionCheck(bob, entity, id, loaded, bobSave).catch((e) => e)) as ServiceError;
  expect(err, entity).toBeInstanceOf(ServiceError);
  expect(err.code).toBe('CONFLICT');
  expect(err.message).toMatch(/^This record was changed by Alice at .+\. Reload to see the latest\.$/);
  expect((err.details as { staleVersion: boolean }).staleVersion).toBe(true);
  // After reloading, Bob's save goes through.
  await withVersionCheck(bob, entity, id, await version(entity, id), bobSave);
}

describe('record locking for every transaction type (P1)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [ua] = await db.insert(users).values({ email: 'alice@p1c.local', name: 'Alice', passwordHash: 'x' }).returning();
    const [ub] = await db.insert(users).values({ email: 'bob@p1c.local', name: 'Bob', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'P1 Concurrency Co', ownerId: ua.id }).returning();
    alice = { db, companyId: company.id, userId: ua.id };
    bob = { db, companyId: company.id, userId: ub.id };
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Savings', 'asset', 'savings'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6000', 'Office Expense', 'expense', 'operating_expenses'],
    ] as const) {
      acct[code] = (await createAccount(alice, { code, name, type, subtype })).id;
    }
    customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Acme' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Depot' }).returning())[0].id;
    await postJournalEntry(alice, {
      date: d('2026-01-01'),
      description: 'Opening',
      lines: [
        { accountId: acct['1000'], debit: '5000.00' },
        { accountId: acct['3000'], credit: '5000.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('covers every record type QB locks, on the server and in the client', () => {
    for (const e of [
      'invoice', 'bill', 'journal_entry', 'customer', 'vendor', 'item', 'estimate', 'sales_order',
      'sales_receipt', 'credit_memo', 'purchase_order', 'expense', 'deposit', 'transfer',
      'payment_received', 'bill_payment', 'vendor_credit', 'item_receipt', 'paycheck', 'employee', 'account',
    ]) {
      expect(VERSIONED_ENTITIES).toContain(e);
    }
    expect(VERSIONED_RESOURCES.length).toBe(VERSIONED_ENTITIES.length);
    for (const r of ['estimates', 'sales-orders', 'sales-receipts', 'credit-memos', 'purchase-orders', 'expenses', 'deposits', 'transfers', 'payments', 'bill-payments', 'vendor-credits', 'item-receipts', 'payroll', 'employees', 'accounts']) {
      expect(VERSIONED_RESOURCES).toContain(r);
    }
  });

  it('checks: a stale save is refused and changes nothing', async () => {
    const exp = await createExpense(alice, {
      vendorId,
      date: d('2026-02-01'),
      method: 'check',
      reference: '100',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '40.00' }],
    });
    const base = { vendorId, date: d('2026-02-01'), method: 'check' as const, reference: '100', paymentAccountId: acct['1000'] };
    await raceOn(
      'expense',
      exp.id,
      (c) => updateExpense(c, exp.id, { ...base, memo: 'Alice', lines: [{ accountId: acct['6000'], amount: '40.00' }] }),
      (c) => updateExpense(c, exp.id, { ...base, memo: 'Bob', lines: [{ accountId: acct['6000'], amount: '45.00' }] }),
    );
    const [row] = await db.select().from(expenses).where(eq(expenses.id, exp.id));
    expect(row.memo).toBe('Bob'); // Bob's retry after reload
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('a change made outside the version check (a void) still makes an open copy stale', async () => {
    const exp = await createExpense(alice, {
      vendorId,
      date: d('2026-02-02'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '10.00' }],
    });
    const loaded = await version('expense', exp.id);
    await voidExpense(alice, exp.id); // no version sent
    expect(await version('expense', exp.id)).not.toBe(loaded);
    const err = await withVersionCheck(bob, 'expense', exp.id, loaded, (c) =>
      updateExpense(c, exp.id, {
        vendorId,
        date: d('2026-02-02'),
        method: 'cash',
        paymentAccountId: acct['1000'],
        memo: 'late',
        lines: [{ accountId: acct['6000'], amount: '10.00' }],
      }),
    ).catch((e) => e);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/changed by Alice/);
  });

  it('transfers, deposits and vendor credits', async () => {
    const tr = await createTransfer(alice, { date: d('2026-02-03'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '50.00' });
    const trIn = (memo: string, amount: string) => ({ date: d('2026-02-03'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount, memo });
    await raceOn('transfer', tr.id, (c) => updateTransfer(c, tr.id, trIn('a', '50.00')), (c) => updateTransfer(c, tr.id, trIn('b', '60.00')));

    const dep = await createDeposit(alice, { depositAccountId: acct['1000'], date: d('2026-02-04'), extraLines: [{ accountId: acct['3000'], amount: '20.00' }] });
    const depIn = (memo: string) => ({ depositAccountId: acct['1000'], date: d('2026-02-04'), memo, extraLines: [{ accountId: acct['3000'], amount: '20.00' }] });
    await raceOn('deposit', dep.id, (c) => updateDeposit(c, dep.id, depIn('a')), (c) => updateDeposit(c, dep.id, depIn('b')));

    const vc = await createVendorCredit(alice, { vendorId, date: d('2026-02-05'), lines: [{ accountId: acct['6000'], amount: '5.00' }] });
    const vcIn = (amount: string) => ({ vendorId, date: d('2026-02-05'), lines: [{ accountId: acct['6000'], amount }] });
    await raceOn('vendor_credit', vc.id, (c) => updateVendorCredit(c, vc.id, vcIn('6.00')), (c) => updateVendorCredit(c, vc.id, vcIn('7.00')));
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('estimates, purchase orders and sales receipts', async () => {
    const est = await createEstimate(alice, { customerId, date: d('2026-03-01'), lines: [{ description: 'Work', quantity: 1, rate: 100 }] });
    await raceOn('estimate', est.id, (c) => updateEstimateStatus(c, est.id, 'accepted' as never), (c) => updateEstimateStatus(c, est.id, 'rejected' as never));

    const po = await createPurchaseOrder(alice, { vendorId, date: d('2026-03-02'), lines: [{ accountId: acct['6000'], quantity: '1', rate: '10' }] } as never);
    const poIn = (memo: string) => ({ vendorId, date: d('2026-03-02'), memo, lines: [{ accountId: acct['6000'], quantity: '1', rate: '10' }] });
    await raceOn('purchase_order', po.id, (c) => updatePurchaseOrder(c, po.id, poIn('a') as never), (c) => updatePurchaseOrder(c, po.id, poIn('b') as never));

    const sr = await createSalesReceipt(alice, { date: d('2026-03-03'), depositAccountId: acct['1000'], lines: [{ accountId: acct['4000'], description: 'Sale', quantity: 1, rate: 30 }] } as never);
    const srIn = (memo: string) => ({ date: d('2026-03-03'), depositAccountId: acct['1000'], memo, lines: [{ accountId: acct['4000'], description: 'Sale', quantity: 1, rate: 30 }] });
    await raceOn('sales_receipt', sr.id, (c) => updateSalesReceipt(c, sr.id, srIn('a') as never), (c) => updateSalesReceipt(c, sr.id, srIn('b') as never));
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('employees', async () => {
    const emp = await createEmployee(alice, { firstName: 'Pat', lastName: 'Lee', payType: 'salary', payRate: '50000.00' } as never);
    await raceOn('employee', emp.id, (c) => updateEmployee(c, emp.id, { firstName: 'Patricia' } as never), (c) => updateEmployee(c, emp.id, { firstName: 'Patrick' } as never));
  });

  it('accounts: an edit makes an open account stale, a posting does not', async () => {
    const id = acct['6000'];
    const loaded = await version('account', id);
    // Someone posts to the account: balance changes, but the account record itself didn't.
    await postJournalEntry(alice, {
      date: d('2026-04-01'),
      description: 'Supplies',
      lines: [
        { accountId: id, debit: '3.00' },
        { accountId: acct['1000'], credit: '3.00' },
      ],
    });
    expect(await version('account', id)).toBe(loaded);
    await withVersionCheck(bob, 'account', id, loaded, (c) => updateAccount(c, id, { description: 'Bob' }));
    // Alice still has the original copy open: refused, naming Bob.
    const err = await withVersionCheck(alice, 'account', id, loaded, (c) => updateAccount(c, id, { description: 'Alice' })).catch((e) => e);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/changed by Bob/);
    const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(row.description).toBe('Bob');
  });

  it('returns the bumped version so the same user can save twice in a row', async () => {
    const tr = await createTransfer(alice, { date: d('2026-02-06'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '1.00' });
    let v = await version('transfer', tr.id);
    for (const memo of ['one', 'two', 'three']) {
      const out = (await withVersionCheck(alice, 'transfer', tr.id, v, (c) =>
        updateTransfer(c, tr.id, { date: d('2026-02-06'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '1.00', memo }),
      )) as { updatedAt: Date };
      v = new Date(out.updatedAt).toISOString();
      expect(v).toBe(await version('transfer', tr.id));
    }
  });
});
