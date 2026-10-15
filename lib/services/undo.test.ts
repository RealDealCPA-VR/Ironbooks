/**
 * Undo for everything (ux/undo): every action kind for several entity types, applied through the
 * normal services — ledger stays balanced, closing date respected, stale / expired / foreign-user
 * / reused tokens refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, undoActions, invoices, userCompanies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount, getAccount, deactivateAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, getInvoice, updateInvoice, voidInvoice } from './invoices';
import { createBill, getBill, updateBill } from './bills';
import { createExpense, getExpense, voidExpense } from './expenses';
import { createManualEntry, getEntry, updateEntry } from './journal';
import { receivePayment, getPayment } from './payments';
import { createTransfer, updateTransfer, getTransfer } from './transfers';
import { createPurchaseOrder, getPurchaseOrder, updateStatus as updatePoStatus } from './purchaseOrders';
import { createEstimate, getEstimate } from './estimates';
import { createCustomer, updateCustomer, deactivateCustomer, getCustomer } from './customers';
import { updateVendor } from './vendors';
import { createItem, updateItem, getItem } from './items';
import { setClosingDate } from './company';
import { commitUndo, performUndo, prepareUndo, type UndoKind } from './undo';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-undo');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function balance(code: string): Promise<string> {
  return (await getAccount(ctx, acct[code])).balance;
}
async function expectBalanced() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
}

/** What the client does around a save: prepare (snapshot) -> action -> commit (arm). */
async function track<T>(
  resource: string,
  kind: UndoKind,
  id: string | null,
  action: () => Promise<T>,
  c: ServiceContext = ctx,
): Promise<{ result: T; token: string }> {
  const prepared = kind === 'create' ? null : await prepareUndo(c, { resource, kind, id: id! });
  const result = await action();
  const r = result as { id?: string; payment?: { id?: string } };
  const createdId = kind === 'create' ? (r.id ?? r.payment?.id ?? null) : null;
  const armed = await commitUndo(c, { resource, kind, token: prepared?.token ?? null, id: createdId });
  return { result, token: armed.token };
}

describe('undo service', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'undo@test.local', name: 'Dana', passwordHash: 'x' }).returning();
    const [user2] = await db.insert(users).values({ email: 'undo2@test.local', name: 'Sam', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Undo Co', ownerId: user.id }).returning();
    await db.insert(userCompanies).values({ userId: user2.id, companyId: company.id, role: 'admin' });
    ctx = { db, companyId: company.id, userId: user.id };
    other = { db, companyId: company.id, userId: user2.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Savings', 'asset', 'savings'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
      ['6400', 'Rent', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Acme' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Depot' }).returning())[0].id;
    await createManualEntry(ctx, {
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

  const invoiceInput = (amount: string, refNumber?: string) => ({
    customerId,
    refNumber: refNumber ?? null,
    date: d('2026-03-01'),
    lines: [{ accountId: acct['4000'], description: 'Consulting', quantity: '1', rate: amount, taxable: false }],
  });

  it('undoes an invoice create by voiding it; the ledger stays balanced', async () => {
    const before = await balance('1200');
    const { result: inv, token } = await track('invoices', 'create', null, () => createInvoice(ctx, invoiceInput('250.00')));
    expect(await balance('1200')).not.toBe(before);
    const out = await performUndo(ctx, token);
    expect(out.message).toMatch(/voided/);
    expect((await getInvoice(ctx, inv.id)).status).toBe('void');
    expect(await balance('1200')).toBe(before);
    await expectBalanced();
  });

  it('undoes an invoice edit by restoring the earlier lines through updateInvoice', async () => {
    const inv = await createInvoice(ctx, invoiceInput('100.00'));
    const { token } = await track('invoices', 'update', inv.id, () =>
      updateInvoice(ctx, inv.id, { ...invoiceInput('175.00'), memo: 'raised' }),
    );
    expect((await getInvoice(ctx, inv.id)).total).toBe('175.00');
    await performUndo(ctx, token);
    const back = await getInvoice(ctx, inv.id);
    expect(back.total).toBe('100.00');
    expect(back.memo).toBeNull();
    expect(back.status).not.toBe('void');
    await expectBalanced();
  });

  it('undoes an invoice void by re-entering a copy with the same number, and says so', async () => {
    const inv = await createInvoice(ctx, invoiceInput('320.00', 'INV-900'));
    const arBefore = await balance('1200');
    const { token } = await track('invoices', 'void', inv.id, () => voidInvoice(ctx, inv.id));
    expect(Money(await balance('1200'))).toBe(Money(arBefore) - 320);
    const out = await performUndo(ctx, token);
    expect(out.copy).toBe(true);
    expect(out.message).toMatch(/can't be un-voided/);
    expect(out.message).toMatch(/INV-900/);
    const copy = await getInvoice(ctx, out.newId!);
    expect(copy.refNumber).toBe('INV-900');
    expect(copy.total).toBe('320.00');
    expect((await getInvoice(ctx, inv.id)).status).toBe('void');
    expect(await balance('1200')).toBe(arBefore);
    await expectBalanced();
  });

  it('undoes a bill create and a bill edit', async () => {
    const apBefore = await balance('2000');
    const billIn = (amt: string) => ({
      vendorId,
      billNumber: 'B-1',
      date: d('2026-03-02'),
      lines: [{ accountId: acct['6400'], amount: amt }],
    });
    const created = await track('bills', 'create', null, () => createBill(ctx, billIn('500.00')));
    await performUndo(ctx, created.token);
    expect((await getBill(ctx, created.result.id)).status).toBe('void');
    expect(await balance('2000')).toBe(apBefore);

    const bill = await createBill(ctx, billIn('80.00'));
    const { token } = await track('bills', 'update', bill.id, () => updateBill(ctx, bill.id, { ...billIn('95.00'), memo: 'x' }));
    await performUndo(ctx, token);
    const back = await getBill(ctx, bill.id);
    expect(back.total).toBe('80.00');
    expect(back.lines).toHaveLength(1);
    expect(back.lines[0].amount).toBe('80.00');
    await expectBalanced();
  });

  it('undoes a check void by re-entering it with the same check number', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: d('2026-03-03'),
      method: 'check',
      reference: '1001',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '42.00' }],
    });
    const bank = await balance('1000');
    const { token } = await track('expenses', 'void', exp.id, () => voidExpense(ctx, exp.id));
    const out = await performUndo(ctx, token);
    const copy = await getExpense(ctx, out.newId!);
    expect(copy.reference).toBe('1001');
    expect(copy.total).toBe('42.00');
    expect(await balance('1000')).toBe(bank);
    await expectBalanced();
  });

  it('undoes a journal entry edit (the entry is replaced on edit) and a journal entry create', async () => {
    const je = await createManualEntry(ctx, {
      date: d('2026-03-04'),
      description: 'Accrual',
      lines: [
        { accountId: acct['6400'], debit: '300.00' },
        { accountId: acct['1000'], credit: '300.00' },
      ],
    });
    const { result: replacement, token } = await track('journal-entries', 'update', je.id, () =>
      updateEntry(ctx, je.id, {
        date: d('2026-03-04'),
        description: 'Accrual (fixed)',
        lines: [
          { accountId: acct['6400'], debit: '350.00' },
          { accountId: acct['1000'], credit: '350.00' },
        ],
      }),
    );
    const rent = await balance('6400');
    const out = await performUndo(ctx, token);
    expect(out.message).toMatch(/reversed/);
    expect((await getEntry(ctx, replacement.id)).status).toBe('void');
    expect(Number(await balance('6400'))).toBeCloseTo(Number(rent) - 50, 2);

    const created = await track('journal-entries', 'create', null, () =>
      createManualEntry(ctx, {
        date: d('2026-03-05'),
        description: 'Oops',
        lines: [
          { accountId: acct['6300'], debit: '10.00' },
          { accountId: acct['1000'], credit: '10.00' },
        ],
      }),
    );
    await performUndo(ctx, created.token);
    expect((await getEntry(ctx, created.result.id)).status).toBe('void');
    await expectBalanced();
  });

  it('undoes a customer payment (voids it and reopens the invoice)', async () => {
    const inv = await createInvoice(ctx, invoiceInput('60.00'));
    const { result: pay, token } = await track('payments', 'create', null, () =>
      receivePayment(ctx, {
        customerId,
        date: d('2026-03-06'),
        method: 'check',
        amount: '60.00',
        depositAccountId: acct['1050'],
        applications: [{ invoiceId: inv.id, amountApplied: '60.00' }],
      }),
    );
    expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
    await performUndo(ctx, token);
    expect((await getPayment(ctx, pay.payment.id)).voidedAt).not.toBeNull();
    expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('60.00');
    await expectBalanced();
  });

  it('undoes a transfer edit', async () => {
    const t = await createTransfer(ctx, { date: d('2026-03-07'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '200.00' });
    const { token } = await track('transfers', 'update', t.id, () =>
      updateTransfer(ctx, t.id, { date: d('2026-03-07'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '250.00' }),
    );
    await performUndo(ctx, token);
    expect((await getTransfer(ctx, t.id)).amount).toBe('200.00');
    await expectBalanced();
  });

  it('reopens a voided purchase order and rejects an estimate whose create is undone', async () => {
    const po = await createPurchaseOrder(ctx, {
      vendorId,
      date: d('2026-03-08'),
      lines: [{ accountId: acct['6300'], description: 'Paper', quantity: '2', rate: '5' }],
    });
    const { token } = await track('purchase-orders', 'void', po.id, () => updatePoStatus(ctx, po.id, 'void'));
    const out = await performUndo(ctx, token);
    expect(out.copy).toBeUndefined();
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('open');

    const est = await track('estimates', 'create', null, () =>
      createEstimate(ctx, { customerId, date: d('2026-03-08'), lines: [{ description: 'Job', quantity: '1', rate: '10' }] }),
    );
    await performUndo(ctx, est.token);
    expect((await getEstimate(ctx, est.result.id)).status).toBe('rejected');
  });

  it('list records: undo create (inactive), update (restored) and delete (active again)', async () => {
    const c = await track('customers', 'create', null, () => createCustomer(ctx, { displayName: 'Brand New' }));
    await performUndo(ctx, c.token);
    expect((await getCustomer(ctx, c.result.id)).isActive).toBe(false);

    const u = await track('customers', 'update', customerId, () => updateCustomer(ctx, customerId, { displayName: 'Acme Renamed', email: 'a@b.co' }));
    await performUndo(ctx, u.token);
    const back = await getCustomer(ctx, customerId);
    expect(back.displayName).toBe('Acme');
    expect(back.email).toBeNull();

    const del = await track('customers', 'delete', customerId, () => deactivateCustomer(ctx, customerId));
    expect((await getCustomer(ctx, customerId)).isActive).toBe(false);
    await performUndo(ctx, del.token);
    expect((await getCustomer(ctx, customerId)).isActive).toBe(true);

    const v = await track('vendors', 'update', vendorId, () => updateVendor(ctx, vendorId, { notes: 'net 15 only' }));
    await performUndo(ctx, v.token);

    const item = await createItem(ctx, { name: 'Widget', type: 'service', salesPrice: '5.00', incomeAccountId: acct['4000'] });
    const iu = await track('items', 'update', item.id, () => updateItem(ctx, item.id, { name: 'Widget Pro', salesPrice: '9.00' }));
    await performUndo(ctx, iu.token);
    const ib = await getItem(ctx, item.id);
    expect(ib.name).toBe('Widget');
    expect(ib.salesPrice).toBe('5.00');

    const a = await createAccount(ctx, { code: '6999', name: 'Misc', type: 'expense' as never, subtype: 'operating_expenses' });
    const ad = await track('accounts', 'delete', a.id, () => deactivateAccount(ctx, a.id));
    await performUndo(ctx, ad.token);
    expect((await getAccount(ctx, a.id)).isActive).toBe(true);
  });

  it('refuses a second undo, another user, an expired token and a record changed since', async () => {
    const created = await track('invoices', 'create', null, () => createInvoice(ctx, invoiceInput('11.00')));
    await expect(performUndo(other, created.token)).rejects.toThrow(/Only the person who made this change/);
    await performUndo(ctx, created.token);
    await expect(performUndo(ctx, created.token)).rejects.toThrow(/already undone/);

    const late = await track('invoices', 'create', null, () => createInvoice(ctx, invoiceInput('12.00')));
    await db.update(undoActions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(undoActions.id, late.token));
    await expect(performUndo(ctx, late.token)).rejects.toThrow(/Too late to undo/);
    expect((await getInvoice(ctx, late.result.id)).status).not.toBe('void');

    const inv = await createInvoice(ctx, invoiceInput('13.00'));
    const edit = await track('invoices', 'update', inv.id, () => updateInvoice(ctx, inv.id, invoiceInput('14.00')));
    // Someone else edits it afterwards: the undo must not overwrite that.
    await updateInvoice(other, inv.id, invoiceInput('15.00'));
    await expect(performUndo(ctx, edit.token)).rejects.toThrow(/changed again by Sam/);
    expect((await getInvoice(ctx, inv.id)).total).toBe('15.00');
    // A refused undo stays refused (the claim is rolled back but the record is still newer).
    await expect(performUndo(ctx, edit.token)).rejects.toThrow(/changed again/);
  });

  it('only arms an undo when the audit trail shows this user made the change', async () => {
    const inv = await createInvoice(ctx, invoiceInput('16.00'));
    const prepared = await prepareUndo(ctx, { resource: 'invoices', kind: 'update', id: inv.id });
    // No save happened.
    await expect(commitUndo(ctx, { resource: 'invoices', kind: 'update', token: prepared.token })).rejects.toThrow(/nothing to undo/);
    // Another user's token can't be committed either.
    const p2 = await prepareUndo(other, { resource: 'invoices', kind: 'update', id: inv.id });
    await updateInvoice(other, inv.id, invoiceInput('17.00'));
    await expect(commitUndo(ctx, { resource: 'invoices', kind: 'update', token: p2.token })).rejects.toThrow(/not found/i);
    const [row] = await db.select().from(undoActions).where(and(eq(undoActions.id, prepared.token)));
    expect(row.status).toBe('pending');
  });

  it('respects the closing date: undo of a closed-period change needs the closing-date password', async () => {
    const inv = await createInvoice(ctx, { ...invoiceInput('70.00'), date: d('2026-01-15') });
    const { token } = await track('invoices', 'update', inv.id, () =>
      updateInvoice(ctx, inv.id, { ...invoiceInput('75.00'), date: d('2026-01-15') }),
    );
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    try {
      await expect(performUndo(ctx, token)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      expect((await getInvoice(ctx, inv.id)).total).toBe('75.00');
      // With the closing-date password (ctx.closingDateOverride) the same token still works.
      await performUndo({ ...ctx, closingDateOverride: true }, token);
      expect((await getInvoice(ctx, inv.id)).total).toBe('70.00');
      await expectBalanced();
    } finally {
      await setClosingDate(ctx, { closingDate: null, password: null } as never);
    }
    const [row] = await db.select({ n: invoices.id }).from(invoices).where(eq(invoices.id, inv.id));
    expect(row).toBeTruthy();
  });
});

function Money(s: string): number {
  return Math.round(Number(s) * 100) / 100;
}
