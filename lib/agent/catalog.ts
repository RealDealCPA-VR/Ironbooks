/**
 * The catalog of named things an agent may ask Ironbooks to do (run by lib/agent/actions.ts).
 *
 * Each action is a thin, typed wrapper round the route a person uses for the same thing (`route`,
 * one operation of the registry): `request` turns the action's input into that route's own
 * request, the agent's door (lib/agent/operate.ts) runs it under the agent's policy exactly as
 * run_operation would, and `answer` puts the route's answer in the action's words. So an agent
 * with the A/P Clerk role can enter a bill and cannot enter an invoice, like a person with that
 * role, and an agent whose policy asks for changes asks a person here too.
 *
 * `run` is the same work done through the service directly. It is kept for the requests copied
 * from the old approval queue, which are entered that way under the approving person's
 * permissions (runApprovedAgentAction). Nothing here posts to the ledger by itself: an invoice goes
 * through createInvoice, a void through the document's own void, and the ledger only through
 * lib/services/posting.ts, with its balance, closing-date and name rules.
 *
 * What is deliberately not here: deleting anything for good, users and roles, backups and other
 * file utilities, preferences and settings, payroll, and anything that reaches outside the
 * computer (email, AI services). The generic run_operation reaches those, under the policy.
 */
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { accounts, customers, vendors } from '@/lib/db/schema';
import { Money, toDecimal, type MoneyInput } from '@/lib/money';
import { type ServiceContext, validation } from '@/lib/services/_base';
import { assertCurrentVersion, withVersionCheck, type VersionedEntity } from '@/lib/services/concurrency';
import { createManualEntry, updateEntry, voidEntry } from '@/lib/services/journal';
import { createInvoice, updateInvoice, voidInvoice } from '@/lib/services/invoices';
import { createSalesReceipt, updateSalesReceipt, voidSalesReceipt } from '@/lib/services/salesReceipts';
import { receivePayment, updatePayment, voidPayment } from '@/lib/services/payments';
import { createBill, updateBill, voidBill } from '@/lib/services/bills';
import { payBillsWithCredits, updateBillPayment, voidBillPayment } from '@/lib/services/billPayments';
import { createExpense, updateExpense, voidExpense } from '@/lib/services/expenses';
import { createDeposit, updateDeposit, voidDeposit } from '@/lib/services/deposits';
import { createTransfer, updateTransfer, voidTransfer } from '@/lib/services/transfers';
import { createCustomer, updateCustomer, deactivateCustomer } from '@/lib/services/customers';
import { createVendor, updateVendor, deactivateVendor } from '@/lib/services/vendors';
import { createAccount, updateAccount, deactivateAccount } from '@/lib/services/accounts';
import { createItem, updateItem, deactivateItem } from '@/lib/services/items';
import { createClass, deactivateClass } from '@/lib/services/dimensions';
import { createJournalEntrySchema, updateJournalEntrySchema } from '@/lib/validation/journal';
import { createInvoiceBodySchema, updateInvoiceSchema } from '@/lib/validation/invoices';
import { createSalesReceiptSchema } from '@/lib/validation/salesReceipts';
import { receivePaymentSchema } from '@/lib/validation/payments';
import { createBillSchema } from '@/lib/validation/bills';
import { payBillsSchema } from '@/lib/validation/billPayments';
import { createExpenseSchema } from '@/lib/validation/expenses';
import { createDepositSchema } from '@/lib/validation/deposits';
import { createTransferSchema } from '@/lib/validation/transfers';
import { createCustomerSchema, updateCustomerSchema } from '@/lib/validation/customers';
import { createVendorSchema, updateVendorSchema } from '@/lib/validation/vendors';
import { createAccountSchema, updateAccountSchema } from '@/lib/validation/accounts';
import { createItemSchema, updateItemSchema } from '@/lib/validation/items';
import { createClassSchema } from '@/lib/validation/dimensions';
import { zUuid } from '@/lib/validation/helpers';
import { type AgentActionDef, registerAgentActions } from './actions';
import { AGENT_BANKING_ACTIONS } from './banking';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

// ---------------------------------------------------------------------------
// Shaping what comes back
// ---------------------------------------------------------------------------

const day = (v: unknown) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return typeof v === 'string' && v ? v.slice(0, 10) : null;
};
const stamp = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

/**
 * The facts about a saved document an agent needs to go on: its id, the number people see, its
 * date, total and status, and `updated_at`, which a later edit or void can pass back so a change
 * someone else made in between is not overwritten.
 */
export function documentResult(type: string, row: Any): Record<string, unknown> {
  const r = row ?? {};
  const out: Record<string, unknown> = { type, id: r.id ?? null };
  const number = r.refNumber ?? r.billNumber ?? r.reference ?? (r.invoiceNumber ?? r.receiptNumber ?? r.entryNumber ?? null);
  if (number !== null && number !== undefined && number !== '') out.number = String(number);
  if (r.date) out.date = day(r.date);
  if (r.dueDate) out.due_date = day(r.dueDate);
  for (const [k, key] of [['total', 'total'], ['amount', 'amount'], ['balanceDue', 'balance_due'], ['status', 'status']] as const) {
    if (r[k] !== undefined && r[k] !== null) out[key] = r[k];
  }
  // Checks, deposits and transfers have no status of their own: they are either live or void.
  if (out.status === undefined && 'voidedAt' in r) out.status = r.voidedAt ? 'void' : 'posted';
  if (r.postedEntryId) out.journal_entry_id = r.postedEntryId;
  const version = r.updatedAt ?? r.editedAt;
  if (version) out.updated_at = stamp(version);
  return out;
}

function listResult(type: string, row: Any): Record<string, unknown> {
  const r = row ?? {};
  const out: Record<string, unknown> = { type, id: r.id ?? null, name: r.displayName ?? r.name ?? null };
  if (r.code) out.number = r.code;
  if (typeof r.isActive === 'boolean') out.active = r.isActive;
  const version = r.updatedAt ?? r.editedAt;
  if (version) out.updated_at = stamp(version);
  return out;
}

// ---------------------------------------------------------------------------
// Words for the approval queue
// ---------------------------------------------------------------------------

async function nameIn(ctx: ServiceContext, table: typeof customers | typeof vendors, id: unknown): Promise<string> {
  if (typeof id !== 'string') return 'unknown';
  const [row] = await ctx.db.select({ name: table.displayName }).from(table).where(and(eq(table.id, id), eq(table.companyId, ctx.companyId)));
  return row?.name ?? 'unknown';
}
async function accountName(ctx: ServiceContext, id: unknown): Promise<string> {
  if (typeof id !== 'string') return 'unknown account';
  const [row] = await ctx.db.select({ code: accounts.code, name: accounts.name }).from(accounts).where(and(eq(accounts.id, id), eq(accounts.companyId, ctx.companyId)));
  return row ? [row.code, row.name].filter(Boolean).join(' ') : 'unknown account';
}
/** An amount as "$12.50", in decimal (lib/money.ts); text that is not an amount as it was given. */
export const money = (v: unknown): string => {
  try {
    return `$${toDecimal(v as MoneyInput).toFixed(2)}`;
  } catch {
    return String(v ?? '');
  }
};
/** The total of lines that carry an amount, or quantity × rate / unit cost (each line to the cent). */
function linesTotal(lines: Any[] | undefined): string {
  let total = Money.zero();
  for (const l of lines ?? []) {
    const rate = l.rate ?? l.unitCost;
    try {
      const amount = l.amount ?? (l.quantity !== undefined && rate !== undefined ? Money.mul(l.quantity, rate) : (l.debit ?? 0));
      total = total.plus(Money.round2(amount));
    } catch {
      // Not an amount: the route refuses the request, and says why.
    }
  }
  return money(total);
}
/** The sum of a list of amounts; one that is not an amount counts as nothing (the route refuses it). */
function sumOf(values: unknown[]): string {
  let total = Money.zero();
  for (const v of values) {
    try {
      total = total.plus(toDecimal(v as MoneyInput));
    } catch {
      // See above.
    }
  }
  return money(total);
}

// ---------------------------------------------------------------------------
// Editing and voiding: one shape for every kind of record
// ---------------------------------------------------------------------------

const expectedVersion = z
  .string()
  .datetime({ offset: true, message: 'must be the updated_at of the record as you last read it' })
  .nullish();

/** `{ id, expectedUpdatedAt?, changes }`: the record, the version the agent last saw, the new content. */
const editSchema = <S extends z.ZodTypeAny>(changes: S) => z.object({ id: zUuid, expectedUpdatedAt: expectedVersion, changes }).strict();
const targetSchema = z.object({ id: zUuid, expectedUpdatedAt: expectedVersion }).strict();

/**
 * The version the agent last read, checked before the request is sent: a change someone made
 * since is refused instead of overwritten (409, details.staleVersion), as a person's window is.
 * It runs only for a request the policy does not refuse (lib/agent/actions.ts throughDoor): its
 * answer names who changed the record last, which an agent refused the work must not learn.
 * The route compares it again only for a request that carries the version header, which a request
 * through the door cannot yet (lib/agent/contract.ts OperationInput has no field for it), so a
 * change made between this check and the commit is not caught here; a request a person approves
 * later is covered by the preview's staleness check instead (lib/agent/bridge.ts).
 */
const versionCheck =
  (entity: VersionedEntity) =>
  async (ctx: ServiceContext, i: { id: string; expectedUpdatedAt?: string | null }): Promise<void> => {
    if (i.expectedUpdatedAt) await assertCurrentVersion(ctx, entity, i.id, i.expectedUpdatedAt);
  };

interface RecordKind {
  /** The word used in action names and answers: 'invoice', 'bill_payment' … */
  type: string;
  label: string;
  entity: VersionedEntity;
  /** The person's route for this kind (list path; `[id]` is added for edits and voids). */
  path: string;
  editMethod: 'PATCH' | 'PUT';
  editSchema: z.ZodTypeAny;
  edit: (ctx: ServiceContext, id: string, changes: Any) => Promise<Any>;
  /** Void for a transaction, make inactive for a list entry. */
  remove: (ctx: ServiceContext, id: string) => Promise<Any>;
  /** The record in the action's words, from the service's answer or the route's (which may wrap it). */
  shape: (row: Any) => Record<string, unknown>;
}

/** The record inside an answer that may wrap it (`{ payment, entry }`, `{ expense }` …). */
const unwrap = (v: Any, key: string) => (v && typeof v === 'object' && v[key] && typeof v[key] === 'object' ? v[key] : v);

const TRANSACTIONS: RecordKind[] = [
  {
    type: 'journal_entry', label: 'journal entry', entity: 'journal_entry', path: '/api/journal-entries', editMethod: 'PATCH', editSchema: updateJournalEntrySchema,
    edit: (ctx, id, c) => updateEntry(ctx, id, { date: c.date, description: c.description, reference: c.reference ?? null, lines: c.lines, isAdjusting: c.isAdjusting, allowReconciledEdit: c.allowReconciledEdit }),
    remove: (ctx, id) => voidEntry(ctx, id),
    shape: (r) => documentResult('journal_entry', unwrap(r, 'entry')),
  },
  {
    type: 'invoice', label: 'invoice', entity: 'invoice', path: '/api/invoices', editMethod: 'PATCH', editSchema: updateInvoiceSchema,
    edit: (ctx, id, c) => updateInvoice(ctx, id, c),
    remove: (ctx, id) => voidInvoice(ctx, id),
    shape: (r) => documentResult('invoice', r),
  },
  {
    type: 'sales_receipt', label: 'sales receipt', entity: 'sales_receipt', path: '/api/sales-receipts', editMethod: 'PATCH', editSchema: createSalesReceiptSchema,
    edit: (ctx, id, c) => updateSalesReceipt(ctx, id, c),
    remove: (ctx, id) => voidSalesReceipt(ctx, id),
    shape: (r) => documentResult('sales_receipt', r),
  },
  {
    type: 'payment', label: 'customer payment', entity: 'payment_received', path: '/api/payments', editMethod: 'PATCH', editSchema: receivePaymentSchema,
    edit: (ctx, id, c) => updatePayment(ctx, id, c),
    remove: (ctx, id) => voidPayment(ctx, id),
    shape: (r) => documentResult('payment', unwrap(r, 'payment')),
  },
  {
    type: 'bill', label: 'bill', entity: 'bill', path: '/api/bills', editMethod: 'PATCH', editSchema: createBillSchema,
    edit: (ctx, id, { allowDuplicateNumber, ...c }) => updateBill(ctx, id, { ...c, checkDuplicateNumber: !allowDuplicateNumber }),
    remove: (ctx, id) => voidBill(ctx, id),
    shape: (r) => documentResult('bill', r),
  },
  {
    type: 'bill_payment', label: 'bill payment', entity: 'bill_payment', path: '/api/bill-payments', editMethod: 'PATCH', editSchema: payBillsSchema,
    edit: (ctx, id, { allowDuplicateNumber, ...c }) => updateBillPayment(ctx, id, { ...c, paymentAccountId: c.paymentAccountId ?? '', checkDuplicateNumber: !allowDuplicateNumber }),
    remove: (ctx, id) => voidBillPayment(ctx, id),
    shape: (r) => documentResult('bill_payment', unwrap(r, 'payment')),
  },
  {
    type: 'check', label: 'check or charge', entity: 'expense', path: '/api/expenses', editMethod: 'PATCH', editSchema: createExpenseSchema,
    edit: (ctx, id, { allowDuplicateNumber, ...c }) => updateExpense(ctx, id, { ...c, checkDuplicateNumber: !allowDuplicateNumber }),
    remove: (ctx, id) => voidExpense(ctx, id),
    shape: (r) => documentResult('check', unwrap(r, 'expense')),
  },
  {
    type: 'deposit', label: 'deposit', entity: 'deposit', path: '/api/deposits', editMethod: 'PATCH', editSchema: createDepositSchema,
    edit: (ctx, id, c) => updateDeposit(ctx, id, c),
    remove: (ctx, id) => voidDeposit(ctx, id),
    shape: (r) => documentResult('deposit', r),
  },
  {
    type: 'transfer', label: 'transfer', entity: 'transfer', path: '/api/transfers', editMethod: 'PATCH', editSchema: createTransferSchema,
    edit: (ctx, id, c) => updateTransfer(ctx, id, c),
    remove: (ctx, id) => voidTransfer(ctx, id),
    shape: (r) => documentResult('transfer', r),
  },
];

const LIST_ENTRIES: RecordKind[] = [
  {
    type: 'customer', label: 'customer', entity: 'customer', path: '/api/customers', editMethod: 'PATCH', editSchema: updateCustomerSchema,
    edit: (ctx, id, c) => updateCustomer(ctx, id, c),
    remove: (ctx, id) => deactivateCustomer(ctx, id),
    shape: (r) => listResult('customer', r),
  },
  {
    type: 'vendor', label: 'vendor', entity: 'vendor', path: '/api/vendors', editMethod: 'PATCH', editSchema: updateVendorSchema,
    edit: (ctx, id, c) => updateVendor(ctx, id, c),
    remove: (ctx, id) => deactivateVendor(ctx, id),
    shape: (r) => listResult('vendor', r),
  },
  {
    type: 'account', label: 'account', entity: 'account', path: '/api/accounts', editMethod: 'PATCH', editSchema: updateAccountSchema,
    edit: (ctx, id, c) => updateAccount(ctx, id, c),
    remove: (ctx, id) => deactivateAccount(ctx, id),
    shape: (r) => listResult('account', r),
  },
  {
    type: 'item', label: 'item', entity: 'item', path: '/api/items', editMethod: 'PATCH', editSchema: updateItemSchema,
    edit: (ctx, id, { reorderPoint: _reorder, ...c }) => updateItem(ctx, id, c),
    remove: (ctx, id) => deactivateItem(ctx, id),
    shape: (r) => listResult('item', unwrap(r, 'item')),
  },
];

/** The kinds `edit_*` and `void_*` / `deactivate_*` actions exist for. mcp/tools.mjs lists the same words. */
export const AGENT_TRANSACTION_TYPES = TRANSACTIONS.map((k) => k.type);
export const AGENT_LIST_TYPES = [...LIST_ENTRIES.map((k) => k.type), 'class'];

/**
 * Edit a record: the person's PATCH of that record, with the new content as its body. The route
 * reads the same fields the action's schema allows (and turns allowDuplicateNumber into its own
 * duplicate check); a confirmation flag in the body is one the door counts as sent (guards.ts).
 */
function editAction(kind: RecordKind): AgentActionDef<Any> {
  return {
    name: `edit_${kind.type}`,
    kind: 'write',
    route: { path: `${kind.path}/[id]`, method: kind.editMethod },
    schema: editSchema(kind.editSchema),
    describe: (_ctx, i) => `Edit ${kind.label} ${i.id}`,
    check: versionCheck(kind.entity),
    request: (i) => ({ params: { id: i.id }, body: i.changes }),
    answer: (r) => kind.shape(r),
    run: async (ctx, i) => kind.shape(await withVersionCheck(ctx, kind.entity, i.id, i.expectedUpdatedAt ?? null, (c) => kind.edit(c, i.id, i.changes))),
  };
}
/** Void a transaction, or make a list entry inactive: the person's DELETE of that record. */
function removeAction(kind: RecordKind, verb: 'void' | 'deactivate'): AgentActionDef<Any> {
  return {
    name: `${verb}_${kind.type}`,
    kind: 'write',
    route: { path: `${kind.path}/[id]`, method: 'DELETE' },
    schema: targetSchema,
    describe: (_ctx, i) => `${verb === 'void' ? 'Void' : 'Make inactive:'} ${kind.label} ${i.id}`,
    check: versionCheck(kind.entity),
    request: (i) => ({ params: { id: i.id } }),
    answer: (r) => kind.shape(r),
    run: async (ctx, i) => kind.shape(await withVersionCheck(ctx, kind.entity, i.id, i.expectedUpdatedAt ?? null, (c) => kind.remove(c, i.id))),
  };
}

// ---------------------------------------------------------------------------
// Entering new records
// ---------------------------------------------------------------------------

/** Opening stock changes inventory value: a person enters it in Ironbooks itself. */
function noOpeningStock(i: Any): void {
  const some = (v: unknown) => {
    try {
      return !toDecimal(v as MoneyInput).isZero();
    } catch {
      return true; // not a number at all: certainly not "no opening stock"
    }
  };
  if (some(i.openingQuantity) || some(i.openingValue)) {
    throw validation('Add the item without an opening quantity. Opening stock is entered in Ironbooks (New Item, or Adjust Quantity/Value on Hand).');
  }
}

/** The item's fields without opening stock, which noOpeningStock has made sure is none. */
function withoutOpeningStock(i: Any): Any {
  const { openingQuantity: _q, openingValue: _v, openingUnitCost: _c, openingAsOf: _a, openingCosting: _k, ...rest } = i;
  return rest;
}

const ENTER: AgentActionDef<Any>[] = [
  {
    name: 'enter_journal_entry',
    kind: 'write',
    route: { path: '/api/journal-entries', method: 'POST' },
    schema: createJournalEntrySchema,
    describe: (_ctx, i) => `Journal entry ${day(i.date)}: ${i.description} (${linesTotal(i.lines)})`,
    answer: (r) => documentResult('journal_entry', unwrap(r, 'entry')),
    run: async (ctx, i) => documentResult('journal_entry', await createManualEntry(ctx, { date: i.date, description: i.description, reference: i.reference ?? null, lines: i.lines, isAdjusting: i.isAdjusting })),
  },
  {
    name: 'enter_invoice',
    kind: 'write',
    route: { path: '/api/invoices', method: 'POST' },
    schema: createInvoiceBodySchema,
    describe: async (ctx, i) => `Invoice to ${await nameIn(ctx, customers, i.customerId)} ${day(i.date)} (${linesTotal(i.lines)} before tax)`,
    // An invoice of its own lines only: billing time and costs is a different flow, not this tool's.
    request: ({ billables: _billables, ...input }) => ({ body: input }),
    answer: (r) => documentResult('invoice', r),
    run: async (ctx, { billables: _billables, ...input }) => documentResult('invoice', await createInvoice(ctx, input)),
  },
  {
    name: 'enter_sales_receipt',
    kind: 'write',
    route: { path: '/api/sales-receipts', method: 'POST' },
    schema: createSalesReceiptSchema,
    describe: async (ctx, i) => `Sales receipt ${i.customerId ? `for ${await nameIn(ctx, customers, i.customerId)} ` : ''}${day(i.date)} (${linesTotal(i.lines)} before tax)`,
    answer: (r) => documentResult('sales_receipt', r),
    run: async (ctx, i) => documentResult('sales_receipt', await createSalesReceipt(ctx, i)),
  },
  {
    name: 'receive_payment',
    kind: 'write',
    route: { path: '/api/payments', method: 'POST' },
    schema: receivePaymentSchema,
    describe: async (ctx, i) => `Payment of ${money(i.amount)} from ${await nameIn(ctx, customers, i.customerId)} ${day(i.date)}`,
    answer: (r) => documentResult('payment', unwrap(r, 'payment')),
    run: async (ctx, i) => documentResult('payment', unwrap(await receivePayment(ctx, i), 'payment')),
  },
  {
    name: 'enter_bill',
    kind: 'write',
    route: { path: '/api/bills', method: 'POST' },
    schema: createBillSchema,
    describe: async (ctx, i) => `Bill from ${await nameIn(ctx, vendors, i.vendorId)} ${day(i.date)}${i.billNumber ? ` no. ${i.billNumber}` : ''} (${linesTotal(i.lines)})`,
    answer: (r) => documentResult('bill', r),
    run: async (ctx, { allowDuplicateNumber, ...input }) => documentResult('bill', await createBill(ctx, { ...input, checkDuplicateNumber: !allowDuplicateNumber })),
  },
  {
    name: 'pay_bills',
    kind: 'write',
    route: { path: '/api/bill-payments', method: 'POST' },
    schema: payBillsSchema,
    describe: async (ctx, i) => {
      const applications: Any[] = i.applications ?? [];
      return `Pay ${applications.length} bill(s) of ${await nameIn(ctx, vendors, i.vendorId)} ${day(i.date)} (${sumOf(applications.map((a) => a.amountApplied))})`;
    },
    answer: (out: Any) => ({ ...(out?.payment ? documentResult('bill_payment', out.payment) : { type: 'bill_payment', id: null }), credits_applied: out?.creditsApplied }),
    run: async (ctx, { allowDuplicateNumber, ...input }) => {
      const out = await payBillsWithCredits(ctx, { ...input, paymentAccountId: input.paymentAccountId ?? '', checkDuplicateNumber: !allowDuplicateNumber });
      return { ...(out.payment ? documentResult('bill_payment', out.payment) : { type: 'bill_payment', id: null }), credits_applied: out.creditsApplied };
    },
  },
  {
    name: 'write_check',
    kind: 'write',
    route: { path: '/api/expenses', method: 'POST' },
    schema: createExpenseSchema,
    describe: async (ctx, i) => {
      const payee = i.vendorId ? await nameIn(ctx, vendors, i.vendorId) : (i.payeeName ?? 'a payee');
      const what = i.method === 'credit_card' ? (i.isRefund ? 'Card credit' : 'Card charge') : i.method === 'cash' ? 'Cash expense' : 'Check';
      return `${what} to ${payee} ${day(i.date)} from ${await accountName(ctx, i.paymentAccountId)} (${linesTotal(i.lines)})`;
    },
    answer: (r) => documentResult('check', unwrap(r, 'expense')),
    run: async (ctx, { allowDuplicateNumber, ...input }) => documentResult('check', unwrap(await createExpense(ctx, { ...input, checkDuplicateNumber: !allowDuplicateNumber }), 'expense')),
  },
  {
    name: 'make_deposit',
    kind: 'write',
    route: { path: '/api/deposits', method: 'POST' },
    schema: createDepositSchema,
    describe: async (ctx, i) => `Deposit to ${await accountName(ctx, i.depositAccountId)} ${day(i.date)}`,
    answer: (r) => documentResult('deposit', r),
    run: async (ctx, i) => documentResult('deposit', await createDeposit(ctx, i)),
  },
  {
    name: 'transfer_funds',
    kind: 'write',
    route: { path: '/api/transfers', method: 'POST' },
    schema: createTransferSchema,
    describe: async (ctx, i) => `Transfer ${money(i.amount)} from ${await accountName(ctx, i.fromAccountId)} to ${await accountName(ctx, i.toAccountId)} ${day(i.date)}`,
    answer: (r) => documentResult('transfer', r),
    run: async (ctx, i) => documentResult('transfer', await createTransfer(ctx, i)),
  },
  {
    name: 'add_customer',
    kind: 'write',
    route: { path: '/api/customers', method: 'POST' },
    schema: createCustomerSchema,
    describe: (_ctx, i) => `New customer: ${i.displayName}`,
    answer: (r) => listResult('customer', r),
    run: async (ctx, i) => listResult('customer', await createCustomer(ctx, i)),
  },
  {
    name: 'add_vendor',
    kind: 'write',
    route: { path: '/api/vendors', method: 'POST' },
    schema: createVendorSchema,
    describe: (_ctx, i) => `New vendor: ${i.displayName}`,
    answer: (r) => listResult('vendor', r),
    run: async (ctx, i) => listResult('vendor', await createVendor(ctx, i)),
  },
  {
    name: 'add_account',
    kind: 'write',
    route: { path: '/api/accounts', method: 'POST' },
    schema: createAccountSchema,
    describe: (_ctx, i) => `New account: ${[i.code, i.name].filter(Boolean).join(' ')} (${i.qbType ?? i.type})`,
    answer: (r) => listResult('account', r),
    run: async (ctx, i) => listResult('account', await createAccount(ctx, i)),
  },
  {
    name: 'add_item',
    kind: 'write',
    route: { path: '/api/items', method: 'POST' },
    schema: createItemSchema,
    describe: (_ctx, i) => `New item: ${i.name} (${i.type ?? 'service'})`,
    check: async (_ctx, i) => noOpeningStock(i),
    request: (i) => ({ body: withoutOpeningStock(i) }),
    answer: (r) => listResult('item', unwrap(r, 'item')),
    run: async (ctx, i) => {
      noOpeningStock(i);
      const { reorderPoint: _r, ...input } = withoutOpeningStock(i);
      return listResult('item', await createItem(ctx, input));
    },
  },
  {
    name: 'add_class',
    kind: 'write',
    route: { path: '/api/classes', method: 'POST' },
    schema: createClassSchema,
    describe: (_ctx, i) => `New class: ${i.name}`,
    answer: (r) => listResult('class', r),
    run: async (ctx, i) => listResult('class', await createClass(ctx, i)),
  },
  {
    name: 'deactivate_class',
    kind: 'write',
    route: { path: '/api/classes/[id]', method: 'PATCH' },
    schema: z.object({ id: zUuid }).strict(),
    describe: (_ctx, i) => `Make inactive: class ${i.id}`,
    request: (i) => ({ params: { id: i.id } }),
    answer: (r) => listResult('class', r),
    run: async (ctx, i) => listResult('class', await deactivateClass(ctx, i.id)),
  },
];

const READS: AgentActionDef<Any>[] = [
  {
    // The older name of the list_my_requests verb: what the agent asked for and what became of it
    // (the requests copied from the old approval queue are among them).
    name: 'list_my_proposals',
    kind: 'read',
    route: { path: '/api/agent/requests', method: 'GET' },
    runs: 'self',
    schema: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
    describe: () => 'What this agent asked for, and what a person decided',
    run: async (ctx, i) => {
      const { handleVerb } = await import('./operate');
      const out = (await handleVerb(ctx, 'list_my_requests', i.limit ? { limit: i.limit } : {})) as { requests?: unknown[] };
      const requests = Array.isArray(out?.requests) ? out.requests : [];
      return { count: requests.length, requests };
    },
  },
];

export const AGENT_ACTIONS: AgentActionDef<Any>[] = [
  ...ENTER,
  ...TRANSACTIONS.map(editAction),
  ...TRANSACTIONS.map((k) => removeAction(k, 'void')),
  ...LIST_ENTRIES.map(editAction),
  ...LIST_ENTRIES.map((k) => removeAction(k, 'deactivate')),
  ...READS,
];

registerAgentActions(AGENT_ACTIONS);

/** Every action there is: documents and lists here, statements and reconciliation in ./banking. */
export const ALL_AGENT_ACTIONS: AgentActionDef<Any>[] = [...AGENT_ACTIONS, ...AGENT_BANKING_ACTIONS];
