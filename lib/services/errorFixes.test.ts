/**
 * "Fix errors where they happen" — the services attach machine-readable fixes to the most common
 * errors, computed server-side with exact (Decimal) amounts:
 *   - journal entry out of balance            → add the difference to a line
 *   - date in a closed period                 → move to the first open date / closing-date password / reopen
 *   - duplicate document / check / bill number → next free number / keep anyway
 *   - credit limit exceeded                   → save anyway (existing override)
 *   - required account missing                → the default account (vendor / Preferences / first of its kind)
 *   - not enough inventory                    → sell anyway / sell only what is on hand / adjust
 *   - sales tax off but tax set               → remove the tax
 *   - payment over-applied                    → apply exactly the balance / raise the amount
 *   - deposit vs Undeposited Funds mismatch   → take the items off the deposit / deposit to a bank
 * Each fix is applied with applyFixPatch and the save retried to prove it actually fixes the error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, companies, customers, items, users, vendors } from '@/lib/db/schema';
import { applyFixPatch, type ErrorFix } from '@/lib/errorFixes';
import { type ServiceContext, ServiceError } from './_base';
import { createCompany } from './company';
import { createManualEntry } from './journal';
import { closePeriod, firstOpenDate } from './fiscalPeriods';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { receivePayment } from './payments';
import { createDeposit } from './deposits';
import { createExpense } from './expenses';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { assertStockAvailable, findStockShortfalls } from './stockWarning';
import { defaultAccountFor, missingAccountFixesForIssues } from './errorFixes';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-error-fixes');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;

async function caught(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

function fixById(err: ServiceError, id: string): ErrorFix {
  const f = (err.fixes ?? []).find((x) => x.id === id) as ErrorFix | undefined;
  if (!f) throw new Error(`no fix ${id}; got ${JSON.stringify(err.fixes)}`);
  return f;
}

async function setSettings(patch: Record<string, unknown>) {
  const [c] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  await db
    .update(companies)
    .set({ settings: { ...((c?.settings as Record<string, unknown>) ?? {}), ...patch } })
    .where(eq(companies.id, ctx.companyId));
}

describe('error fixes (server-side)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'fixit@test.local', name: 'Fix It', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Fix It Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    const [cust] = await db.insert(customers).values({ companyId: company.id, displayName: 'Acme' }).returning();
    customerId = cust.id;
    const [v] = await db
      .insert(vendors)
      .values({ companyId: company.id, displayName: 'Paper Co', defaultExpenseAccountId: acct['6300'] })
      .returning();
    vendorId = v.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('journal entry out of balance: "Debits are $40.00 more than credits" + add $40.00 to line 3', async () => {
    const input = {
      date: new Date('2026-06-15'),
      description: 'Out of balance',
      lines: [
        { accountId: acct['6300'], debit: '100.00' },
        { accountId: acct['1000'], credit: '30.00' },
        { accountId: acct['1010'], credit: '30.00' },
      ],
    };
    const err = await caught(createManualEntry(ctx, input));
    expect(err.code).toBe('UNBALANCED');
    expect(err.message).toBe('Debits are $40.00 more than credits. An entry must have equal debits and credits.');
    expect((err.details as { difference: string }).difference).toBe('40.00');
    const add = fixById(err, 'balance-add');
    expect(add.label).toBe("Add $40.00 to line 3's credit");
    expect(add.patch).toEqual([{ op: 'add', path: 'lines.2.credit', amount: '40.00' }]);
    expect(fixById(err, 'balance-lower').patch).toEqual([{ op: 'add', path: 'lines.0.debit', amount: '-40.00' }]);

    const fixed = applyFixPatch(input, add.patch);
    expect(fixed.lines[2].credit).toBe('70.00');
    const entry = await createManualEntry(ctx, fixed);
    expect(entry.id).toBeTruthy();
  });

  it('date in a closed period: first open date (closing date + closed fiscal periods) or the password', async () => {
    await setSettings({ closingDate: '2026-01-31' });
    await closePeriod(ctx, { periodStart: new Date('2026-02-01'), periodEnd: new Date('2026-02-28') });
    expect(await firstOpenDate(ctx, new Date('2026-01-10'))).toBe('2026-03-01');
    expect(await firstOpenDate(ctx, new Date('2026-05-10'))).toBe('2026-05-10');

    const input = {
      date: new Date('2026-01-10'),
      description: 'Late entry',
      lines: [
        { accountId: acct['6300'], debit: '12.34' },
        { accountId: acct['1000'], credit: '12.34' },
      ],
    };
    const err = await caught(createManualEntry(ctx, input));
    expect(err.code).toBe('PERIOD_CLOSED');
    const move = fixById(err, 'period-move-date');
    expect(move.label).toBe('Move the date to Mar 1, 2026 (first open date)');
    expect(move.patch).toEqual([{ op: 'set', path: 'date', value: '2026-03-01' }]);
    expect(fixById(err, 'period-password')).toMatchObject({ kind: 'retry', needs: 'closingPassword' });

    // Inside the closed fiscal period: reopen it (no password can open a closed period).
    const feb = await caught(createManualEntry(ctx, { ...input, date: new Date('2026-02-10') }));
    expect(fixById(feb, 'period-reopen')).toMatchObject({ kind: 'navigate', href: '/fiscal-periods' });
    expect(fixById(feb, 'period-move-date').patch).toEqual([{ op: 'set', path: 'date', value: '2026-03-01' }]);

    // Applying the fix (the route parses the ISO date) posts the entry.
    const moved = applyFixPatch({ ...input, date: '2026-01-10' }, move.patch);
    const entry = await createManualEntry(ctx, { ...moved, date: new Date(moved.date) });
    expect(entry.id).toBeTruthy();
    await setSettings({ closingDate: null });
  });

  it('editing/voiding a transaction whose ORIGINAL date is closed: no "move the date" fix', async () => {
    // Closing date: only the password can unlock the original entry.
    const input = { customerId, date: new Date('2026-01-10'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '25.00' }] };
    const inv = await createInvoice(ctx, input);
    await setSettings({ closingDate: '2026-01-31' });
    const edit = await caught(updateInvoice(ctx, inv.id, { ...input, date: new Date('2026-06-10') }));
    expect(edit.code).toBe('PERIOD_CLOSED');
    expect(edit.fixes?.map((f) => f.id)).toEqual(['period-password']);
    const voided = await caught(voidInvoice(ctx, inv.id));
    expect(voided.fixes?.map((f) => f.id)).toEqual(['period-password']);
    // The password still works for the edit.
    const ok = await updateInvoice({ ...ctx, closingDateOverride: true }, inv.id, {
      ...input,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '26.00' }],
    });
    expect(ok.total).toBe('26.00');
    await setSettings({ closingDate: null });

    // Closed fiscal period: reopen it (and still no "move the date").
    const julInput = { ...input, date: new Date('2025-07-10') };
    const jul = await createInvoice(ctx, julInput);
    await closePeriod(ctx, { periodStart: new Date('2025-07-01'), periodEnd: new Date('2025-07-31') });
    const julEdit = await caught(updateInvoice(ctx, jul.id, { ...julInput, date: new Date('2026-06-10') }));
    expect(julEdit.code).toBe('PERIOD_CLOSED');
    expect(julEdit.fixes?.map((f) => f.id)).toEqual(['period-reopen']);

    // A NEW transaction dated in the closed period still gets the move fix.
    const fresh = await caught(createInvoice(ctx, julInput));
    expect(fresh.fixes?.map((f) => f.id)).toContain('period-move-date');
  });

  it('duplicate invoice number: next free number or keep it', async () => {
    const base = {
      customerId,
      date: new Date('2026-06-01'),
      lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '100.00' }],
    };
    await createInvoice(ctx, { ...base, refNumber: 'INV-0042' });
    await createInvoice(ctx, { ...base, refNumber: 'INV-0043' });
    const err = await caught(createInvoice(ctx, { ...base, refNumber: 'INV-0042' }));
    expect(err.code).toBe('CONFLICT');
    const next = fixById(err, 'docnum-next');
    expect(next.patch).toEqual([{ op: 'set', path: 'refNumber', value: 'INV-0044' }]);
    expect(next.label).toBe('Use the next free invoice number, INV-0044');
    expect(fixById(err, 'docnum-keep').patch).toEqual([{ op: 'set', path: 'allowDuplicateNumber', value: true }]);
    const saved = await createInvoice(ctx, applyFixPatch({ ...base, refNumber: 'INV-0042' }, next.patch));
    expect(saved.refNumber).toBe('INV-0044');
  });

  it('duplicate check number: next check number for that bank account', async () => {
    const base = {
      payeeName: 'Corner Store',
      date: new Date('2026-06-02'),
      method: 'check' as const,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '15.00' }],
      checkDuplicateNumber: true,
    };
    await createExpense(ctx, { ...base, reference: '5001' });
    const err = await caught(createExpense(ctx, { ...base, reference: '5001' }));
    expect(err.code).toBe('CONFLICT');
    expect(fixById(err, 'docnum-next').patch).toEqual([{ op: 'set', path: 'reference', value: '5002' }]);
    expect(fixById(err, 'docnum-keep').patch).toEqual([{ op: 'set', path: 'allowDuplicateNumber', value: true }]);
  });

  it('duplicate vendor bill number: keep it (no "next" for a vendor reference)', async () => {
    const base = { vendorId, date: new Date('2026-06-03'), billNumber: 'PC-77', checkDuplicateNumber: true, lines: [{ accountId: acct['6300'], amount: '20.00' }] };
    await createBill(ctx, base);
    const err = await caught(createBill(ctx, base));
    expect(err.fixes?.map((f) => f.id)).toEqual(['docnum-keep']);
  });

  it('credit limit exceeded: Save anyway uses the existing override', async () => {
    const [limited] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Tight Budget', creditLimit: '50.00' })
      .returning();
    const input = { customerId: limited.id, date: new Date('2026-06-04'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '80.00' }] };
    const err = await caught(createInvoice(ctx, input));
    expect((err.details as { warning: string }).warning).toBe('CREDIT_LIMIT');
    const save = fixById(err, 'credit-limit-override');
    expect(save.kind).toBe('retry');
    const inv = await createInvoice(ctx, applyFixPatch(input, save.patch));
    expect(inv.total).toBe('80.00');
  });

  it('sales tax turned off but a tax item is set: remove the tax', async () => {
    await setSettings({ salesTaxEnabled: false });
    const taxRateId = '00000000-0000-4000-8000-000000000001';
    const input = {
      customerId,
      date: new Date('2026-06-05'),
      taxRateId,
      lines: [
        { accountId: acct['4000'], quantity: 1, rate: '10.00' },
        { accountId: acct['4000'], quantity: 1, rate: '5.00', taxRateId },
      ],
    };
    const err = await caught(createInvoice(ctx, input));
    expect(err.code).toBe('FORBIDDEN');
    const remove = fixById(err, 'tax-remove');
    expect(remove.patch).toEqual([
      { op: 'set', path: 'taxRateId', value: null },
      { op: 'set', path: 'lines.1.taxRateId', value: null },
    ]);
    const inv = await createInvoice(ctx, applyFixPatch(input, remove.patch));
    expect(inv.total).toBe('15.00');
    await setSettings({ salesTaxEnabled: true });
  });

  it('negative inventory warning: sell anyway / only what is on hand / adjust', async () => {
    const [widget] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'Widget', type: 'inventory', quantityOnHand: '2.0000' })
      .returning();
    const lines = [
      { accountId: acct['4000'], description: 'Labor', quantity: 1, rate: '5' },
      { itemId: widget.id, quantity: '5', rate: '9' },
    ];
    expect(await findStockShortfalls(ctx, lines)).toEqual([
      { itemId: widget.id, name: 'Widget', need: '5', have: '2', lineIndexes: [1] },
    ]);
    // Editing: what the document already took counts as available.
    expect(await findStockShortfalls(ctx, lines, [{ itemId: widget.id, quantity: '3' }])).toEqual([]);

    const err = await caught(assertStockAvailable(ctx, lines));
    expect((err.details as { warning: string }).warning).toBe('NEGATIVE_STOCK');
    expect(err.message).toContain('Widget: selling 5, only 2 on hand');
    expect(fixById(err, 'stock-continue').patch).toEqual([{ op: 'set', path: 'checkStock', value: false }]);
    expect(fixById(err, 'stock-reduce').patch).toEqual([{ op: 'set', path: 'lines.1.quantity', value: '2' }]);
    expect(fixById(err, 'stock-adjust')).toMatchObject({ kind: 'navigate', href: '/inventory-ops' });

    // Through createInvoice: only when the form asks (checkStock), so internal callers are unaffected.
    const inv = await caught(createInvoice(ctx, { customerId, date: new Date('2026-06-06'), checkStock: true, lines }));
    expect(inv.fixes?.map((f) => f.id)).toEqual(['stock-continue', 'stock-reduce', 'stock-adjust']);

    // Preference off → no warning.
    await setSettings({ negativeStockWarning: false });
    await expect(assertStockAvailable(ctx, lines)).resolves.toBeUndefined();
    await setSettings({ negativeStockWarning: true });
  });

  it('payment over-applied: apply exactly the balance due; applications over the amount: raise it', async () => {
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2026-06-07'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.10' }],
    });
    const input = {
      customerId,
      date: new Date('2026-06-08'),
      method: 'check' as const,
      amount: '150.00',
      applications: [{ invoiceId: invoice.id, amountApplied: '120.00', discountAmount: '10.05' }],
      discountAccountId: acct['4900'],
    };
    const over = await caught(receivePayment(ctx, input));
    const exact = fixById(over, 'apply-exact');
    expect(exact.patch).toEqual([{ op: 'set', path: 'applications.0.amountApplied', value: '90.05' }]);
    expect(exact.label).toContain('$90.05');

    const tooMuch = await caught(receivePayment(ctx, { ...input, amount: '50.00', applications: [{ invoiceId: invoice.id, amountApplied: '60.00' }] }));
    expect(fixById(tooMuch, 'payment-raise').patch).toEqual([{ op: 'set', path: 'amount', value: '60.00' }]);
    expect(fixById(tooMuch, 'payment-trim').patch).toEqual([{ op: 'set', path: 'applications.0.amountApplied', value: '50.00' }]);

    const paid = await receivePayment(ctx, applyFixPatch(input, exact.patch));
    expect(paid.payment.amount).toBe('150.00');
  });

  it('bill payment over-applied: pay exactly what the bill still owes', async () => {
    const bill = await createBill(ctx, { vendorId, date: new Date('2026-06-09'), lines: [{ accountId: acct['6300'], amount: '45.50' }] });
    const input = {
      vendorId,
      date: new Date('2026-06-10'),
      method: 'check' as const,
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '50.00' }],
    };
    const err = await caught(payBills(ctx, input));
    const exact = fixById(err, 'apply-exact');
    expect(exact.patch).toEqual([{ op: 'set', path: 'applications.0.amountApplied', value: '45.50' }]);
    await expect(payBills(ctx, applyFixPatch(input, exact.patch))).resolves.toBeTruthy();
  });

  it('deposit / Undeposited Funds mismatch: take already-deposited payments off; deposit to a bank', async () => {
    const invoice = await createInvoice(ctx, { customerId, date: new Date('2026-06-11'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '30.00' }] });
    const { payment: p1 } = await receivePayment(ctx, {
      customerId,
      date: new Date('2026-06-12'),
      method: 'check',
      amount: '30.00',
      applications: [{ invoiceId: invoice.id, amountApplied: '30.00' }],
    });
    const { payment: p2 } = await receivePayment(ctx, { customerId, date: new Date('2026-06-12'), method: 'cash', amount: '7.00', applications: [] });
    await createDeposit(ctx, { depositAccountId: acct['1000'], date: new Date('2026-06-13'), paymentIds: [p1.id] });

    const input = { depositAccountId: acct['1000'], date: new Date('2026-06-14'), paymentIds: [p1.id, p2.id] };
    const err = await caught(createDeposit(ctx, input));
    expect(err.code).toBe('CONFLICT');
    const remove = fixById(err, 'deposit-remove');
    expect(remove.patch).toEqual([{ op: 'pull', path: 'paymentIds', value: p1.id }]);
    expect(applyFixPatch(input, remove.patch).paymentIds).toEqual([p2.id]);

    const intoUf = await caught(createDeposit(ctx, { ...input, depositAccountId: acct['1050'] }));
    expect(fixById(intoUf, 'account-default').patch).toEqual([{ op: 'set', path: 'depositAccountId', value: acct['1000'] }]);

    const dep = await createDeposit(ctx, applyFixPatch(input, remove.patch));
    expect(dep.id).toBeTruthy();
  });

  it('missing required account: the default (vendor default, Preferences, first of its kind)', async () => {
    expect((await defaultAccountFor(ctx, 'expense', { vendorId }))?.id).toBe(acct['6300']);
    expect((await defaultAccountFor(ctx, 'expense'))?.code).toBe('5000'); // first expense account by code
    await setSettings({ defaultExpenseAccountId: acct['6600'] });
    expect((await defaultAccountFor(ctx, 'expense'))?.id).toBe(acct['6600']);
    expect((await defaultAccountFor(ctx, 'bank'))?.id).toBe(acct['1000']); // never Undeposited Funds

    const fixes = await missingAccountFixesForIssues(
      ctx,
      [
        { path: 'lines.1.accountId', message: 'Pick an account or an item.' },
        { path: 'lines.0.amount', message: 'amount is required' },
      ],
      { vendorId, lines: [{ accountId: acct['6400'] }, { amount: '5' }] },
      'expense',
    );
    expect(fixes).toEqual([
      {
        id: 'account-default',
        kind: 'patch',
        label: 'Use 6300 Office Supplies on line 2',
        patch: [{ op: 'set', path: 'lines.1.accountId', value: acct['6300'] }],
      },
    ]);
    // A wrong (non-empty) account is not "missing"; header fields get a bank default.
    expect(await missingAccountFixesForIssues(ctx, [{ path: 'lines.0.accountId', message: 'bad' }], { lines: [{ accountId: 'x' }] }, 'expense')).toEqual([]);
    const bank = await missingAccountFixesForIssues(ctx, [{ path: 'depositAccountId', message: 'Required' }], {}, 'bank', { purpose: 'deposit' });
    expect(bank[0].patch).toEqual([{ op: 'set', path: 'depositAccountId', value: acct['1000'] }]);

    // The fix makes a real save succeed.
    const body = { vendorId, date: new Date('2026-06-15'), lines: [{ accountId: '', amount: '9.99' }] };
    const [useDefault] = await missingAccountFixesForIssues(ctx, [{ path: 'lines.0.accountId', message: 'x' }], body, 'expense');
    const bill = await createBill(ctx, applyFixPatch(body, useDefault.patch));
    expect(bill.total).toBe('9.99');
    const [row] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6300')));
    expect(row.id).toBe(acct['6300']);
  });
});
