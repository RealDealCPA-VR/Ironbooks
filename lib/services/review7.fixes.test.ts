/**
 * Review loop 7 fixes (reconciliation, orders, forms):
 *  - statements are reconciled in date order; Undo names the reconciliation it means;
 *  - a service charge is entered once per reconciliation (a retry doesn't post it again);
 *  - a line ticked in a reconciliation still in progress keeps its tick through an edit;
 *  - an invoice from a sales order is dated today; converting needs the invoice right;
 *  - "(500.00)" typed in an amount field is minus 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { committedAmountText } from '@/lib/shortcuts';
import { unionRoles, type RoleDefinition } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createBankAccount } from './bankAccounts';
import { createCustomer } from './customers';
import { createExpense, updateExpense } from './expenses';
import {
  addStatementAdjustments,
  completeReconciliation,
  getProgress,
  listClearable,
  startReconciliation,
  toggleCleared,
  undoLastReconciliation,
} from './reconcile';
import { convertToInvoice, createSalesOrder } from './salesOrders';
import { createBill } from './bills';
import { createVendor } from './vendors';
import { createInvoiceWithBillables, listUnbilled } from './billables';
import { getInvoice, updateInvoice } from './invoices';
import { companyToday } from './salesDates';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
let bankId: string;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

beforeAll(async () => {
  t = await makeTestCompany('review7');
  bankId = (await createBankAccount(t.ctx, { accountId: t.acct['1000'], bankName: 'Bank', accountNumber: '000777' })).id;
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('reconciliation', { timeout: 120_000 }, () => {
  it('statements in date order, and Undo only of the one the user saw', async () => {
    const mar = await startReconciliation(t.ctx, { bankAccountId: bankId, statementDate: d('2026-03-31'), statementBalance: '0' });
    await completeReconciliation(t.ctx, mar.id);
    await expect(
      startReconciliation(t.ctx, { bankAccountId: bankId, statementDate: d('2025-04-30'), statementBalance: '0' }),
    ).rejects.toThrow(/on or after/);
    await expect(undoLastReconciliation(t.ctx, bankId, '2026-02-28')).rejects.toMatchObject({ code: 'CONFLICT' });
    const undone = await undoLastReconciliation(t.ctx, bankId, '2026-03-31');
    expect(undone.status).toBe('undone');
  });

  it('a service charge is entered once, and an edit keeps an in-progress tick', async () => {
    const exp = await createExpense(t.ctx, {
      payeeName: 'Supply Co',
      date: d('2026-04-10'),
      method: 'check',
      paymentAccountId: t.acct['1000'],
      lines: [{ accountId: t.acct['6300'], amount: '20.00' }],
    });
    const rec = await startReconciliation(t.ctx, { bankAccountId: bankId, statementDate: d('2026-04-30'), statementBalance: '-25.00' });
    await addStatementAdjustments(t.ctx, rec.id, { serviceCharge: { amount: '5.00', accountId: t.acct['6300'] } });
    await expect(addStatementAdjustments(t.ctx, rec.id, { serviceCharge: { amount: '5.00', accountId: t.acct['6300'] } })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const lines = await listClearable(t.ctx, bankId, d('2026-04-30'), rec.id);
    const check = lines.find((l) => Math.abs(Number((l as { amount?: string }).amount ?? 0)) === 20 || String((l as { description?: string }).description ?? '').includes('Supply'));
    expect(check).toBeTruthy();
    await toggleCleared(t.ctx, rec.id, check!.journalEntryLineId, true);
    const before = await getProgress(t.ctx, rec.id);
    expect(before.difference).toBe('0.00');

    // Only the expense account changes: the bank line is the same, so it stays ticked.
    await updateExpense(t.ctx, exp.id, {
      payeeName: 'Supply Co',
      date: d('2026-04-10'),
      method: 'check',
      paymentAccountId: t.acct['1000'],
      lines: [{ accountId: t.acct['6100'], amount: '20.00' }],
    });
    const after = await getProgress(t.ctx, rec.id);
    expect(after.clearedBalance).toBe(before.clearedBalance);
    expect(after.difference).toBe('0.00');
  });
});

describe('sales orders', { timeout: 120_000 }, () => {
  it("an invoice from an order is dated today, and needs the right to create invoices", async () => {
    const c = await createCustomer(t.ctx, { displayName: 'Order Buyer' });
    const so = await createSalesOrder(t.ctx, { customerId: c.id, date: d('2026-01-05'), lines: [{ description: 'Widget', quantity: 1, rate: '50' }] });
    const role = { key: 'custom-so', name: 'SO', description: '', builtin: false, flags: {}, permissions: { 'customers.sales_orders': ['view', 'create', 'modify'] } } as unknown as RoleDefinition;
    const limited: ServiceContext = { ...t.ctx, access: unionRoles([role]) };
    await expect(convertToInvoice(limited, so.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const inv = await convertToInvoice(t.ctx, so.id);
    const today = await companyToday(t.ctx);
    expect(new Date(inv.date).toISOString().slice(0, 10)).toBe(today.toISOString().slice(0, 10));
  });
});

describe('billable costs', { timeout: 120_000 }, () => {
  it('putting back a cost line that another invoice has billed since is refused, not billed twice', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'Billable Twice' });
    const v = await createVendor(t.ctx, { displayName: 'Parts Supplier R7' });
    await createBill(t.ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: t.acct['6300'], amount: '100.00', customerId: c.id, description: 'Parts R7' }] } as never);
    const cost = (await listUnbilled(t.ctx, c.id)).costs.find((x) => x.description === 'Parts R7')!;
    const hdr = { customerId: c.id, date: d('2026-03-05'), taxRateId: null };
    const a = await createInvoiceWithBillables(t.ctx, { ...hdr, lines: [] } as never, { billLineIds: [cost.id] });
    const withCost = (await getInvoice(t.ctx, a.id)).lines.map((l) => ({
      itemId: l.itemId, accountId: l.accountId, description: l.description, quantity: l.quantity, rate: l.rate, taxable: l.taxable,
      billableSource: (l as { billableSource?: unknown }).billableSource ?? null,
    }));
    // Edit A: remove the cost line (released), then bill it on invoice B.
    await updateInvoice(t.ctx, a.id, { ...hdr, lines: [{ accountId: t.acct['4000'], description: 'Labor', quantity: 1, rate: '50.00', taxable: false }] } as never);
    await createInvoiceWithBillables(t.ctx, { ...hdr, lines: [] } as never, { billLineIds: [cost.id] });
    // The old form (or an Undo) puts the cost line back on A.
    await expect(updateInvoice(t.ctx, a.id, { ...hdr, lines: withCost } as never)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('amount fields', () => {
  it('"(500.00)" is minus 500; a decimal comma in an expression is left for validation', () => {
    expect(committedAmountText('(500.00)')).toBe('-500.00');
    expect(committedAmountText('$(1,234.56)')).toBe('-1234.56');
    expect(committedAmountText('12,50*2')).toBeNull();
    expect(committedAmountText('(10+5)*2')).toBe('30');
  });
});
