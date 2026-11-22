/**
 * Test fixture (not a test file): one valid input per `enter` / `change` operation, area by area,
 * for the dry-run parity test (lib/agent/parity.test.ts, plan §10 "Dry-run parity").
 *
 * Each case names a registry operation and builds its input on the parity company. A case that
 * changes a record first makes that record of its own (through `world.commit`, the bridge as the
 * agent), so no two cases change the same record. Order matters in one place only: the first
 * item receipt case must stay the company's first item receipt (it says why).
 * The bodies are in the app's own field names (lib/validation/*.ts).
 *
 * A case whose dry run and real run do not agree keeps `fails`: the patterns of exactly what
 * differs, with a comment saying why. One whose approver's dry run gives another key keeps
 * `approverFails`: the pattern of that difference. The test checks that just those differences are
 * found, so a fix, or a difference of another kind, shows up as a case whose mark needs updating.
 *
 * Only operations whose dry run is really run and rolled back (dryRun 'transaction') are here:
 * 'preview' and 'none' operations are described, not run, so there is nothing to compare
 * (attachments.create is 'none'; payroll.create and receiving.bill are 'preview'). The test's
 * coverage case prints the operations in scope that have no case yet (and the report,
 * PARITY_REPORT, lists them). Some need what this company cannot make without a model or a file:
 * ai.posts.undo (a post the AI made), errors.apply (a correction the AI suggested), receipts.save
 * (an uploaded receipt); currencies.home-currency-adjustment.delete needs foreign currencies.
 */
import type { OperationInput } from '@/lib/agent/contract';
import { Money, toAmountString } from '@/lib/money';

type Obj = Record<string, unknown>;

/** What the parity test gives the fixtures to build their records with. */
export interface ParityTools {
  /** Account ids of the company's chart, by code ("1000" Checking, "4000" Sales Income …). */
  acct: Record<string, string>;
  customerId: string;
  vendorId: string;
  /** Commit one operation through the bridge as the agent; answers its parsed answer. Throws when it did not run. */
  commit(operation: string, input: OperationInput): Promise<Obj>;
  /** Ids of the rows of a table whose column has this value (the lines of a sales order, say). */
  idsWhere(table: string, column: string, value: string): Promise<string[]>;
  /** One column of one row, as text (null when the row or the value is not there). */
  valueOf(table: string, id: string, column: string): Promise<string | null>;
  /** The id of the item of this name (the company's own "Consulting" service, say). */
  itemIdByName(name: string): Promise<string>;
}

/** The records every case may use, made once. */
export interface ParityWorld extends ParityTools {
  serviceItemId: string;
  /** An inventory item with stock on hand (100 at 4.00), for receipts, adjustments and sales. */
  inventoryItemId: string;
  employeeId: string;
  /** A name no other case used yet ("Parity customer 7"). */
  unique(prefix: string): string;
  /** commit() and the id of what it made. */
  make(operation: string, input: OperationInput): Promise<string>;
}

export interface ParityCase {
  /** Registry operation id ("invoices.create"). */
  operation: string;
  /** Tells two cases of one operation apart ("check"). */
  label?: string;
  area: string;
  input(w: ParityWorld): Promise<OperationInput>;
  /**
   * Parity does not hold: one pattern per difference the test finds (its words, lib/agent/
   * parity.test.ts). Every difference found must match a pattern, and every pattern a difference.
   */
  fails?: RegExp[];
  /**
   * The dry run an approval makes, as the approving person, gives another staleness key than the
   * agent's dry run gave (plan §7.4): the pattern of that finding.
   */
  approverFails?: RegExp;
}

/** The words of a staleness key that moved between the agent's two dry runs, the hint matching `hint`. */
const keyMoved = (hint: RegExp): RegExp => new RegExp(`^two dry runs in a row gave different staleness keys \\(.*${hint.source}`);
/** The words of an approver's dry run whose key is not the agent's, the hint matching `hint`. */
const approverKeyMoved = (hint: RegExp): RegExp => new RegExp(`^the approver's dry run gave another staleness key than the agent's \\(.*${hint.source}`);
/** The hint when the two previews show the same and only what the key reads differs. */
const PREVIEWS_AGREE = /the previews agree: the difference is in what the key reads, not what it shows\)$/;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The id an answer carries: its own `id`, else the first record in it that has one ({ invoice: { id } }). */
export function idOf(answer: unknown): string {
  if (isObj(answer)) {
    if (typeof answer.id === 'string') return answer.id;
    for (const v of Object.values(answer)) if (isObj(v) && typeof v.id === 'string') return v.id;
  }
  throw new Error(`The answer names no record id: ${JSON.stringify(answer).slice(0, 300)}`);
}

export async function buildParityWorld(t: ParityTools): Promise<ParityWorld> {
  let n = 0;
  const unique = (prefix: string) => `${prefix} ${++n}`;
  const make = async (operation: string, input: OperationInput) => idOf(await t.commit(operation, input));
  const serviceItemId = await t.itemIdByName('Consulting');
  const inventoryItemId = await make('items.create', {
    body: {
      name: 'Parity widget',
      type: 'inventory',
      salesPrice: '9.00',
      purchaseCost: '4.00',
      incomeAccountId: t.acct['4000'],
      expenseAccountId: t.acct['5000'],
      assetAccountId: t.acct['1300'],
      openingQuantity: '100',
      openingUnitCost: '4.00',
      openingAsOf: '2026-01-02',
    },
  });
  const employeeId = await make('employees.create', { body: { firstName: 'Pat', lastName: 'Parity', payType: 'hourly', payRate: '30.00' } });
  return { ...t, serviceItemId, inventoryItemId, employeeId, unique, make };
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const D = '2026-03-02';

const invoiceBody = (w: ParityWorld, rate = '150.00', customerId = w.customerId): Obj => ({
  customerId,
  date: D,
  lines: [
    { itemId: w.serviceItemId, description: 'Consulting', quantity: '2', rate },
    { accountId: w.acct['4000'], description: 'Materials', quantity: '1', rate: '40.00' },
  ],
  memo: 'Parity invoice',
});
const salesReceiptBody = (w: ParityWorld, rate = '60.00'): Obj => ({
  customerId: w.customerId,
  date: D,
  method: 'cash',
  lines: [{ accountId: w.acct['4000'], description: 'Counter sale', quantity: '1', rate }],
});
const creditMemoBody = (w: ParityWorld, rate = '20.00'): Obj => ({
  customerId: w.customerId,
  date: D,
  lines: [{ accountId: w.acct['4000'], description: 'Return', quantity: '1', rate }],
});
const estimateBody = (w: ParityWorld, rate = '150.00'): Obj => ({
  customerId: w.customerId,
  date: D,
  lines: [{ itemId: w.serviceItemId, description: 'Phase 3', quantity: '2', rate }],
});
const salesOrderBody = (w: ParityWorld, quantity = '3'): Obj => ({
  customerId: w.customerId,
  date: D,
  lines: [{ itemId: w.inventoryItemId, description: 'Widgets', quantity, rate: '9.00' }],
});
const billBody = (w: ParityWorld, amount = '210.00'): Obj => ({
  vendorId: w.vendorId,
  date: D,
  lines: [{ accountId: w.acct['6300'], description: 'Paper', amount }],
});
const vendorCreditBody = (w: ParityWorld, amount = '15.00'): Obj => ({
  vendorId: w.vendorId,
  date: D,
  lines: [{ accountId: w.acct['6300'], description: 'Damaged paper', amount }],
});
const poBody = (w: ParityWorld, quantity = '5'): Obj => ({
  vendorId: w.vendorId,
  date: D,
  lines: [{ itemId: w.inventoryItemId, description: 'Widgets', quantity, rate: '4.00' }],
});
const receiptBody = (w: ParityWorld, quantity: string): Obj => ({
  vendorId: w.vendorId,
  date: D,
  lines: [{ itemId: w.inventoryItemId, description: 'Widgets', quantity, unitCost: '4.00' }],
});
const expenseBody = (w: ParityWorld, method: string, amount = '45.67'): Obj => ({
  vendorId: w.vendorId,
  date: D,
  method,
  paymentAccountId: method === 'credit_card' ? w.acct['2100'] : w.acct['1000'],
  lines: [{ accountId: w.acct['6000'], description: 'Ads', amount }],
});
const transferBody = (w: ParityWorld, amount = '300.00'): Obj => ({
  date: D,
  fromAccountId: w.acct['1000'],
  toAccountId: w.acct['1010'],
  amount,
  memo: 'To savings',
});
const journalBody = (w: ParityWorld, amount = '250.00'): Obj => ({
  date: D,
  description: 'Supplies bought with cash',
  lines: [
    { accountId: w.acct['6300'], debit: amount },
    { accountId: w.acct['1000'], credit: amount },
  ],
});
const timeBody = (w: ParityWorld, customerId = w.customerId, hours = '2.5'): Obj => ({
  customerId,
  employeeId: w.employeeId,
  serviceItemId: w.serviceItemId,
  date: D,
  hours,
  rate: '120.00',
  description: 'Setting up the books',
  billable: true,
});

/** An open invoice of its own, and its total. */
async function openInvoice(w: ParityWorld, customerId = w.customerId): Promise<{ id: string; total: string }> {
  const answer = await w.commit('invoices.create', { body: invoiceBody(w, '150.00', customerId) });
  const inv = isObj(answer.invoice) ? answer.invoice : answer;
  if (typeof inv.total !== 'string' && typeof inv.total !== 'number') throw new Error(`The invoice answer has no total: ${JSON.stringify(answer).slice(0, 300)}`);
  return { id: idOf(answer), total: String(inv.total) };
}

/** A payment of its own into Undeposited Funds, applied to an invoice of its own. */
async function undepositedPayment(w: ParityWorld): Promise<string> {
  const inv = await openInvoice(w);
  return w.make('payments.create', {
    body: { customerId: w.customerId, date: D, method: 'check', reference: w.unique('CHK'), amount: inv.total, applications: [{ invoiceId: inv.id, amountApplied: inv.total }] },
  });
}

async function openBill(w: ParityWorld, amount = '210.00'): Promise<string> {
  return w.make('bills.create', { body: billBody(w, amount) });
}

const paymentBody = (w: ParityWorld, invoiceId: string, amount: string): Obj => ({
  customerId: w.customerId,
  date: D,
  method: 'check',
  reference: w.unique('CHK'),
  amount,
  applications: [{ invoiceId, amountApplied: amount }],
});
const billPaymentBody = (w: ParityWorld, billId: string, amount: string): Obj => ({
  vendorId: w.vendorId,
  date: D,
  method: 'check',
  paymentAccountId: w.acct['1000'],
  applications: [{ billId, amountApplied: amount }],
});

const chargeBody = (w: ParityWorld, rate = '25.00'): Obj => ({ customerId: w.customerId, date: D, accountId: w.acct['4000'], description: 'Late fee', quantity: '1', rate });
const loanBody = (w: ParityWorld): Obj => ({
  name: w.unique('Van loan'),
  liabilityAccountId: w.acct['2300'],
  interestAccountId: w.acct['6700'],
  paymentAccountId: w.acct['1000'],
  originalAmount: '12000.00',
  annualRate: '6.5',
  termMonths: 48,
  originDate: '2026-01-01',
  firstPaymentDate: '2026-02-01',
});

const body = (b: Obj): OperationInput => ({ body: b });
const on = (id: string, b?: Obj): OperationInput => (b === undefined ? { params: { id } } : { params: { id }, body: b });

// ---------------------------------------------------------------------------
// The cases, area by area
// ---------------------------------------------------------------------------

export const PARITY_CASES: ParityCase[] = [
  // --- Sales: invoices, statement charges ---
  { area: 'sales', operation: 'invoices.create', input: async (w) => body(invoiceBody(w)) },
  { area: 'sales', operation: 'invoices.update', input: async (w) => on((await openInvoice(w)).id, invoiceBody(w, '175.00')) },
  { area: 'sales', operation: 'invoices.replace', input: async (w) => on((await openInvoice(w)).id, invoiceBody(w, '180.00')) },
  { area: 'sales', operation: 'invoices.delete', input: async (w) => on((await openInvoice(w)).id) },
  {
    area: 'sales',
    operation: 'invoices.post-draft',
    input: async (w) => on(await w.make('invoices.create', body({ ...invoiceBody(w), status: 'draft' })), {}),
  },
  {
    area: 'sales',
    operation: 'invoices.statement-charges.create',
    input: async (w) => body(chargeBody(w)),
  },
  {
    area: 'sales',
    operation: 'invoices.statement-charges.update',
    input: async (w) => on(await w.make('invoices.statement-charges.create', body(chargeBody(w))), chargeBody(w, '30.00')),
  },

  // --- Sales receipts ---
  { area: 'sales', operation: 'sales-receipts.create', input: async (w) => body(salesReceiptBody(w)) },
  { area: 'sales', operation: 'sales-receipts.update', input: async (w) => on(await w.make('sales-receipts.create', body(salesReceiptBody(w))), salesReceiptBody(w, '75.00')) },
  { area: 'sales', operation: 'sales-receipts.replace', input: async (w) => on(await w.make('sales-receipts.create', body(salesReceiptBody(w))), salesReceiptBody(w, '80.00')) },
  { area: 'sales', operation: 'sales-receipts.delete', input: async (w) => on(await w.make('sales-receipts.create', body(salesReceiptBody(w)))) },

  // --- Payments ---
  {
    area: 'sales',
    operation: 'payments.create',
    input: async (w) => {
      const inv = await openInvoice(w);
      return body(paymentBody(w, inv.id, inv.total));
    },
  },
  {
    area: 'sales',
    operation: 'payments.update',
    input: async (w) => {
      const inv = await openInvoice(w);
      const id = await w.make('payments.create', body(paymentBody(w, inv.id, '100.00')));
      return on(id, paymentBody(w, inv.id, '120.00'));
    },
  },
  {
    area: 'sales',
    operation: 'payments.replace',
    input: async (w) => {
      const inv = await openInvoice(w);
      const id = await w.make('payments.create', body(paymentBody(w, inv.id, '100.00')));
      return on(id, paymentBody(w, inv.id, '140.00'));
    },
  },
  {
    area: 'sales',
    operation: 'payments.delete',
    input: async (w) => {
      const inv = await openInvoice(w);
      return on(await w.make('payments.create', body(paymentBody(w, inv.id, '90.00'))));
    },
  },

  // --- Credit memos ---
  { area: 'sales', operation: 'credit-memos.create', input: async (w) => body(creditMemoBody(w)) },
  { area: 'sales', operation: 'credit-memos.update', input: async (w) => on(await w.make('credit-memos.create', body(creditMemoBody(w))), creditMemoBody(w, '30.00')) },
  { area: 'sales', operation: 'credit-memos.replace', input: async (w) => on(await w.make('credit-memos.create', body(creditMemoBody(w))), creditMemoBody(w, '35.00')) },
  {
    area: 'sales',
    operation: 'credit-memos.action',
    label: 'apply',
    input: async (w) => {
      const inv = await openInvoice(w);
      const memo = await w.make('credit-memos.create', body(creditMemoBody(w)));
      return on(memo, { action: 'apply', invoiceId: inv.id, amount: '20.00', date: D });
    },
    // lib/services/creditMemos.ts writes the new credit application's id into the memo's audit row
    // (newValues.creditApplicationId). That row has no audit 'create' of its own, so the bridge's
    // staleness key (stalenessKeyOf) does not know the id is the run's own: every dry run gives
    // another key. Ledger, records and amount agree.
    fails: [keyMoved(/credit_memo\.creditApplicationId: /)],
    approverFails: approverKeyMoved(/credit_memo\.creditApplicationId: /),
  },
  { area: 'sales', operation: 'credit-memos.delete', input: async (w) => on(await w.make('credit-memos.create', body(creditMemoBody(w)))) },

  // --- Estimates and sales orders ---
  { area: 'sales', operation: 'estimates.create', input: async (w) => body(estimateBody(w)) },
  { area: 'sales', operation: 'estimates.update', input: async (w) => on(await w.make('estimates.create', body(estimateBody(w))), estimateBody(w, '160.00')) },
  {
    area: 'sales',
    operation: 'estimates.action',
    label: 'convert',
    input: async (w) => on(await w.make('estimates.create', body(estimateBody(w))), { action: 'convert' }),
  },
  {
    area: 'sales',
    operation: 'estimates.action',
    label: 'void',
    input: async (w) => on(await w.make('estimates.create', body(estimateBody(w))), { action: 'void' }),
  },
  { area: 'sales', operation: 'sales-orders.create', input: async (w) => body(salesOrderBody(w)) },
  { area: 'sales', operation: 'sales-orders.update', input: async (w) => on(await w.make('sales-orders.create', body(salesOrderBody(w))), salesOrderBody(w, '4')) },
  { area: 'sales', operation: 'sales-orders.replace', input: async (w) => on(await w.make('sales-orders.create', body(salesOrderBody(w))), salesOrderBody(w, '5')) },
  {
    area: 'sales',
    operation: 'sales-orders.action',
    label: 'convert',
    input: async (w) => {
      const so = await w.make('sales-orders.create', body(salesOrderBody(w)));
      const [lineId] = await w.idsWhere('sales_order_lines', 'sales_order_id', so);
      return on(so, { action: 'convert', date: D, lines: [{ lineId, quantity: '2' }] });
    },
  },
  {
    area: 'sales',
    operation: 'sales-orders.action',
    label: 'close',
    input: async (w) => on(await w.make('sales-orders.create', body(salesOrderBody(w))), { action: 'status', status: 'closed' }),
  },

  // --- Purchases: bills and bill payments ---
  { area: 'purchases', operation: 'bills.create', input: async (w) => body(billBody(w)) },
  { area: 'purchases', operation: 'bills.update', input: async (w) => on(await openBill(w), billBody(w, '260.00')) },
  { area: 'purchases', operation: 'bills.delete', input: async (w) => on(await openBill(w)) },
  { area: 'purchases', operation: 'bill-payments.create', input: async (w) => body(billPaymentBody(w, await openBill(w), '210.00')) },
  {
    area: 'purchases',
    operation: 'bill-payments.update',
    input: async (w) => {
      const bill = await openBill(w);
      const id = await w.make('bill-payments.create', body(billPaymentBody(w, bill, '100.00')));
      return on(id, billPaymentBody(w, bill, '150.00'));
    },
  },
  {
    area: 'purchases',
    operation: 'bill-payments.delete',
    input: async (w) => on(await w.make('bill-payments.create', body(billPaymentBody(w, await openBill(w), '210.00')))),
  },

  // --- Vendor credits ---
  { area: 'purchases', operation: 'vendor-credits.create', input: async (w) => body(vendorCreditBody(w)) },
  { area: 'purchases', operation: 'vendor-credits.update', input: async (w) => on(await w.make('vendor-credits.create', body(vendorCreditBody(w))), vendorCreditBody(w, '18.00')) },
  {
    area: 'purchases',
    operation: 'vendor-credits.action',
    label: 'apply',
    input: async (w) => {
      const bill = await openBill(w);
      const credit = await w.make('vendor-credits.create', body(vendorCreditBody(w)));
      return on(credit, { action: 'apply', billId: bill, amount: '15.00', date: D });
    },
  },
  { area: 'purchases', operation: 'vendor-credits.delete', input: async (w) => on(await w.make('vendor-credits.create', body(vendorCreditBody(w)))) },

  // --- Purchase orders and item receipts ---
  { area: 'purchases', operation: 'purchase-orders.create', input: async (w) => body(poBody(w)) },
  { area: 'purchases', operation: 'purchase-orders.update', input: async (w) => on(await w.make('purchase-orders.create', body(poBody(w))), poBody(w, '7')) },
  {
    area: 'purchases',
    operation: 'purchase-orders.action',
    label: 'convert',
    input: async (w) => on(await w.make('purchase-orders.create', body(poBody(w))), { action: 'convert', date: D }),
  },
  {
    area: 'purchases',
    operation: 'purchase-orders.action',
    label: 'close',
    input: async (w) => on(await w.make('purchase-orders.create', body(poBody(w))), { action: 'close' }),
  },
  {
    // The company's FIRST item receipt (no case before this one makes one: keep it first). The
    // service makes the Item Receipts Accrual account then (lib/services/itemReceipts.ts
    // getOrCreateAccrualAccount) with a plain insert and no audit row. Each run makes its own, with
    // an id of its own, and the bridge's staleness key reads that id in the ledger lines: two dry
    // runs never agree. Ledger (the account by code and name), records and amount agree.
    area: 'purchases',
    operation: 'item-receipts.create',
    label: 'first, makes the accrual account',
    input: async (w) => body(receiptBody(w, '6')),
    fails: [keyMoved(/Item Receipts Accrual/)],
    approverFails: approverKeyMoved(/Item Receipts Accrual/),
  },
  { area: 'purchases', operation: 'item-receipts.create', input: async (w) => body(receiptBody(w, '3')) },
  { area: 'purchases', operation: 'item-receipts.update', input: async (w) => on(await w.make('item-receipts.create', body(receiptBody(w, '2'))), receiptBody(w, '4')) },
  {
    area: 'purchases',
    operation: 'item-receipts.action',
    label: 'convert',
    input: async (w) =>
      on(await w.make('item-receipts.create', body(receiptBody(w, '2'))), {
        action: 'convert',
        date: D,
      }),
  },

  // --- Expenses and checks ---
  { area: 'purchases', operation: 'expenses.create', label: 'card expense', input: async (w) => body(expenseBody(w, 'credit_card')) },
  { area: 'purchases', operation: 'expenses.create', label: 'check', input: async (w) => body({ ...expenseBody(w, 'check'), reference: w.unique('70').replace(' ', '') }) },
  { area: 'purchases', operation: 'expenses.update', input: async (w) => on(await w.make('expenses.create', body(expenseBody(w, 'credit_card'))), expenseBody(w, 'credit_card', '55.00')) },
  { area: 'purchases', operation: 'expenses.delete', input: async (w) => on(await w.make('expenses.create', body(expenseBody(w, 'credit_card')))) },

  // --- Banking: deposits, transfers, a register entry ---
  { area: 'banking', operation: 'deposits.create', input: async (w) => body({ depositAccountId: w.acct['1000'], date: D, paymentIds: [await undepositedPayment(w)], memo: 'Parity deposit' }) },
  {
    area: 'banking',
    operation: 'deposits.update',
    input: async (w) => {
      const first = await undepositedPayment(w);
      const id = await w.make('deposits.create', body({ depositAccountId: w.acct['1000'], date: D, paymentIds: [first] }));
      return on(id, { depositAccountId: w.acct['1000'], date: D, paymentIds: [first, await undepositedPayment(w)], memo: 'Two payments now' });
    },
  },
  {
    area: 'banking',
    operation: 'deposits.delete',
    input: async (w) => on(await w.make('deposits.create', body({ depositAccountId: w.acct['1000'], date: D, paymentIds: [await undepositedPayment(w)] }))),
  },
  { area: 'banking', operation: 'transfers.create', input: async (w) => body(transferBody(w)) },
  { area: 'banking', operation: 'transfers.update', input: async (w) => on(await w.make('transfers.create', body(transferBody(w))), transferBody(w, '350.00')) },
  { area: 'banking', operation: 'transfers.delete', input: async (w) => on(await w.make('transfers.create', body(transferBody(w)))) },
  {
    area: 'banking',
    operation: 'registers.action',
    label: 'check',
    input: async (w) => ({
      params: { accountId: w.acct['1000'] },
      body: { date: D, payee: 'Paper Supply Co', otherAccountId: w.acct['6300'], side: 'decrease', amount: '42.00', memo: 'Typed in the register' },
    }),
  },

  // --- Accounting: journal entries, adjusting entries, accounts ---
  { area: 'accounting', operation: 'journal-entries.create', input: async (w) => body(journalBody(w)) },
  { area: 'accounting', operation: 'journal-entries.update', input: async (w) => on(await w.make('journal-entries.create', body(journalBody(w))), journalBody(w, '275.00')) },
  { area: 'accounting', operation: 'journal-entries.reverse', input: async (w) => on(await w.make('journal-entries.create', body(journalBody(w))), { asOfDate: '2026-04-01' }) },
  { area: 'accounting', operation: 'journal-entries.delete', input: async (w) => on(await w.make('journal-entries.create', body(journalBody(w)))) },
  {
    area: 'accounting',
    operation: 'accountant.working-trial-balance.adjust',
    input: async (w) =>
      body({
        date: '2026-03-31',
        description: 'March rent paid from savings, booked late',
        lines: [
          { accountId: w.acct['6400'], debit: '1200.00' },
          { accountId: w.acct['1010'], credit: '1200.00' },
        ],
      }),
  },
  {
    area: 'accounting',
    operation: 'accounts.create',
    input: async (w) => body({ code: '1020', name: w.unique('Petty cash'), type: 'asset', subtype: 'checking', openingBalance: '500.00', openingBalanceDate: '2026-01-01' }),
  },
  {
    area: 'accounting',
    operation: 'accounts.update',
    input: async (w) => on(await w.make('accounts.create', body({ code: '6810', name: w.unique('Postage'), type: 'expense', subtype: 'operating_expenses' })), { name: w.unique('Postage and shipping'), description: 'Stamps' }),
  },

  // --- Lists: customers, vendors, items, classes, locations, jobs, employees and more ---
  { area: 'lists', operation: 'customers.create', input: async (w) => body({ displayName: w.unique('Parity customer'), email: 'books@parity.test', openingBalance: '100.00', openingBalanceDate: '2026-01-01' }) },
  { area: 'lists', operation: 'customers.update', input: async (w) => on(await w.make('customers.create', body({ displayName: w.unique('Parity customer') })), { phone: '555-0101', notes: 'Prefers email' }) },
  { area: 'lists', operation: 'vendors.create', input: async (w) => body({ displayName: w.unique('Parity vendor'), openingBalance: '80.00', openingBalanceDate: '2026-01-01' }) },
  { area: 'lists', operation: 'vendors.update', input: async (w) => on(await w.make('vendors.create', body({ displayName: w.unique('Parity vendor') })), { phone: '555-0102', notes: 'Net 15' }) },
  {
    area: 'lists',
    operation: 'items.create',
    input: async (w) =>
      body({
        name: w.unique('Parity gadget'),
        type: 'inventory',
        salesPrice: '20.00',
        purchaseCost: '8.00',
        incomeAccountId: w.acct['4000'],
        expenseAccountId: w.acct['5000'],
        assetAccountId: w.acct['1300'],
        openingQuantity: '10',
        openingUnitCost: '8.00',
        openingAsOf: '2026-01-02',
      }),
  },
  {
    area: 'lists',
    operation: 'items.delete',
    label: 'make inactive',
    input: async (w) => on(await w.make('items.create', body({ name: w.unique('Old service'), type: 'service', salesPrice: '10.00', incomeAccountId: w.acct['4100'] }))),
  },
  {
    area: 'lists',
    operation: 'items.update',
    input: async (w) => on(await w.make('items.create', body({ name: w.unique('Parity service'), type: 'service', salesPrice: '50.00', incomeAccountId: w.acct['4100'] })), { salesPrice: '55.00', description: 'Hourly' }),
  },
  { area: 'lists', operation: 'classes.create', input: async (w) => body({ name: w.unique('Wholesale') }) },
  { area: 'lists', operation: 'locations.create', input: async (w) => body({ name: w.unique('Warehouse') }) },
  { area: 'lists', operation: 'jobs.create', input: async (w) => body({ name: w.unique('Kitchen remodel'), customerId: w.customerId, budget: '5000.00', startDate: D }) },
  {
    area: 'lists',
    operation: 'jobs.update',
    input: async (w) => on(await w.make('jobs.create', body({ name: w.unique('Deck'), customerId: w.customerId, budget: '2000.00' })), { budget: '2500.00', endDate: '2026-06-30' }),
  },
  { area: 'lists', operation: 'employees.create', input: async (w) => body({ firstName: 'Lee', lastName: w.unique('Parity'), payType: 'salary', payRate: '52000.00' }) },
  {
    area: 'lists',
    operation: 'employees.update',
    input: async (w) => on(await w.make('employees.create', body({ firstName: 'Sam', lastName: w.unique('Parity'), payType: 'hourly', payRate: '22.00' })), { payRate: '24.00', phone: '555-0103' }),
  },
  { area: 'lists', operation: 'leads.create', input: async (w) => body({ name: w.unique('Prospect'), status: 'warm', email: 'hello@prospect.test' }) },
  { area: 'lists', operation: 'leads.update', input: async (w) => on(await w.make('leads.create', body({ name: w.unique('Prospect') })), { status: 'hot', notes: 'Asked for a quote' }) },
  { area: 'lists', operation: 'leads.convert', input: async (w) => on(await w.make('leads.create', body({ name: w.unique('Prospect'), companyName: 'Prospect LLC' })), {}) },
  { area: 'lists', operation: 'pricing.levels.create', input: async (w) => body({ name: w.unique('Wholesale 10'), type: 'fixed_percent', percent: '10' }) },
  {
    area: 'lists',
    operation: 'pricing.levels.update',
    input: async (w) => on(await w.make('pricing.levels.create', body({ name: w.unique('Trade'), type: 'fixed_percent', percent: '5' })), { name: w.unique('Trade'), type: 'fixed_percent', percent: '7.5' }),
  },
  { area: 'lists', operation: 'uom-sets.create', input: async (w) => body({ name: w.unique('Count'), kind: 'count', baseUnitName: 'Each', baseUnitAbbrev: 'ea' }) },
  {
    area: 'lists',
    operation: 'uom-sets.update',
    input: async (w) =>
      on(await w.make('uom-sets.create', body({ name: w.unique('Length'), kind: 'length', baseUnitName: 'Foot', baseUnitAbbrev: 'ft' })), {
        name: w.unique('Length'),
        kind: 'length',
        baseUnitName: 'Foot',
        baseUnitAbbrev: 'ft',
        defaultSalesUnit: 'Foot',
      }),
  },
  { area: 'lists', operation: 'billing-rate-levels.create', input: async (w) => body({ name: w.unique('Senior rate'), type: 'fixed_rate', fixedRate: '140.00' }) },
  {
    area: 'lists',
    operation: 'billing-rate-levels.update',
    input: async (w) => on(await w.make('billing-rate-levels.create', body({ name: w.unique('Junior rate'), type: 'fixed_rate', fixedRate: '80.00' })), { name: w.unique('Junior rate'), type: 'fixed_rate', fixedRate: '85.00' }),
  },
  { area: 'inventory', operation: 'inventory-sites.create', input: async (w) => body({ name: w.unique('Back room'), code: w.unique('BR').replace(' ', '') }) },
  { area: 'inventory', operation: 'inventory-sites.update', input: async (w) => on(await w.make('inventory-sites.create', body({ name: w.unique('Shed') })), { name: w.unique('Garden shed'), notes: 'Padlocked' }) },

  // --- Time and mileage ---
  { area: 'time', operation: 'time-entries.create', input: async (w) => body(timeBody(w)) },
  { area: 'time', operation: 'time-entries.update', input: async (w) => on(await w.make('time-entries.create', body(timeBody(w))), { hours: '3.0', description: 'Books set up, and a review' }) },
  {
    area: 'time',
    operation: 'time-entries.bill',
    input: async (w) => {
      const customerId = await w.make('customers.create', body({ displayName: w.unique('Hourly client') }));
      await w.make('time-entries.create', body(timeBody(w, customerId, '4')));
      return body({ customerId });
    },
  },
  { area: 'time', operation: 'mileage.create', input: async (w) => body({ employeeId: w.employeeId, customerId: w.customerId, date: D, miles: '42', ratePerMile: '0.67', purpose: 'Client visit', billable: true }) },

  // --- Inventory ---
  { area: 'inventory', operation: 'inventory.adjust', input: async (w) => body({ action: 'adjust', itemId: w.inventoryItemId, quantityChange: '-3', date: D, memo: 'Broken in the stockroom' }) },
  { area: 'inventory', operation: 'inventory-sites.adjust', input: async (w) => body({ itemId: w.inventoryItemId, quantityChange: '-1', date: D, memo: 'Sample given away' }) },
  { area: 'inventory', operation: 'inventory.value-adjust', input: async (w) => body({ itemId: w.inventoryItemId, newUnitCost: '4.50', date: D, reason: 'Supplier price change' }) },

  // --- Budgets ---
  { area: 'planning', operation: 'budgets.create', input: async (w) => body({ name: w.unique('Plan 2026'), fiscalYear: 2026 }) },
  {
    area: 'planning',
    operation: 'budgets.update',
    input: async (w) => on(await w.make('budgets.create', body({ name: w.unique('Plan 2026'), fiscalYear: 2026 })), { accountId: w.acct['6400'], month: 3, amount: '1200.00' }),
  },

  {
    area: 'planning',
    operation: 'budgets.copy',
    input: async (w) => {
      const id = await w.make('budgets.create', body({ name: w.unique('Plan 2026'), fiscalYear: 2026 }));
      await w.commit('budgets.update', on(id, { accountId: w.acct['6400'], month: 1, amount: '1000.00' }));
      return on(id, { name: w.unique('Plan 2027'), fiscalYear: 2027 });
    },
  },
  {
    area: 'planning',
    operation: 'recurring.create',
    input: async (w) => body({ name: w.unique('Monthly rent'), docType: 'journal_entry', frequency: 'monthly', nextRunDate: '2026-04-01', mode: 'remind', template: journalBody(w, '1200.00') }),
  },

  // --- Payroll set-up ---
  {
    area: 'payroll',
    operation: 'payroll-items.create',
    input: async (w) => body({ name: w.unique('Uniform deduction'), kind: 'deduction', liabilityAccountId: w.acct['2300'], calcBasis: 'fixed', defaultRate: '25.00' }),
  },

  // --- Fixed assets and loans ---
  {
    area: 'accounting',
    operation: 'fixed-assets.create',
    input: async (w) => body({ name: w.unique('Laptop'), cost: '1800.00', usefulLifeMonths: 36, placedInService: '2026-01-15', assetAccountId: w.acct['1500'] }),
  },
  {
    area: 'accounting',
    operation: 'fixed-assets.action',
    label: 'depreciate',
    input: async (w) =>
      on(await w.make('fixed-assets.create', body({ name: w.unique('Printer'), cost: '1200.00', usefulLifeMonths: 24, placedInService: '2026-01-01', assetAccountId: w.acct['1500'] })), {
        action: 'depreciate',
        date: '2026-02-28',
      }),
    // lib/services/fixedAssets.ts writes the new depreciation row's id into the asset's audit row
    // (newValues.depreciationEntryId); that row has no audit 'create' of its own, so the bridge's
    // staleness key takes it for a value the run read: every dry run gives another key. Ledger,
    // records and amount agree.
    fails: [keyMoved(/fixed_asset\.depreciationEntryId: /)],
    approverFails: approverKeyMoved(/fixed_asset\.depreciationEntryId: /),
  },
  { area: 'banking', operation: 'loans.create', input: async (w) => body(loanBody(w)) },
  {
    area: 'banking',
    operation: 'loans.payments',
    input: async (w) => on(await w.make('loans.create', body(loanBody(w))), loanPaymentBody(w)),
  },
  { area: 'banking', operation: 'loans.update', input: async (w) => on(await w.make('loans.create', body(loanBody(w))), { ...loanBody(w), annualRate: '6.0', notes: 'Rate cut' }) },
  {
    area: 'banking',
    operation: 'loans.payments.delete',
    input: async (w) => {
      const loan = await w.make('loans.create', body(loanBody(w)));
      const paymentId = idOf(await w.commit('loans.payments', on(loan, loanPaymentBody(w))));
      return { params: { id: loan }, query: { paymentId } };
    },
  },

  // --- Sales, more: statement charges, payment actions, customer prices, billing groups, reps ---
  {
    area: 'sales',
    operation: 'invoices.statement-charges.replace',
    input: async (w) => on(await w.make('invoices.statement-charges.create', body(chargeBody(w))), chargeBody(w, '35.00')),
  },
  {
    area: 'sales',
    operation: 'payments.action',
    label: 'refund',
    input: async (w) => {
      // 400.00 received against a 340.00 invoice: 60.00 left unapplied, refunded by check.
      const inv = await openInvoice(w);
      const id = await w.make('payments.create', body({ ...paymentBody(w, inv.id, inv.total), amount: '400.00' }));
      return on(id, { action: 'refund', bankAccountId: w.acct['1000'], amount: '60.00', date: D, memo: 'Overpayment returned' });
    },
  },
  {
    area: 'sales',
    operation: 'payments.action',
    label: 'unapply',
    input: async (w) => {
      const inv = await openInvoice(w);
      const id = await w.make('payments.create', body(paymentBody(w, inv.id, '100.00')));
      return on(id, { action: 'unapply', invoiceId: inv.id, amount: '40.00' });
    },
  },
  {
    area: 'sales',
    operation: 'payments.action',
    label: 'bounce',
    input: async (w) => {
      // Only a deposited check can bounce.
      const payment = await undepositedPayment(w);
      await w.commit('deposits.create', body({ depositAccountId: w.acct['1000'], date: D, paymentIds: [payment] }));
      return on(payment, { action: 'bounce', date: D, bankFee: '12.00', bankFeeAccountId: w.acct['6100'], customerFee: '25.00', customerFeeAccountId: w.acct['4900'], memo: 'NSF' });
    },
    // lib/services/payments.ts writes the new bounced-check row's id into the payment's audit row
    // (newValues.bouncedCheckId); that row has no audit 'create' of its own, so the key takes it
    // for a value the run read. Ledger (three entries), records and amount agree.
    fails: [keyMoved(/payment_received\.bouncedCheckId: /)],
    approverFails: approverKeyMoved(/payment_received\.bouncedCheckId: /),
  },
  { area: 'sales', operation: 'customer-prices.create', input: async (w) => body({ customerId: w.customerId, itemId: w.serviceItemId, price: '110.00' }) },
  { area: 'sales', operation: 'billing-groups.create', input: async (w) => body({ name: w.unique('Monthly clients'), customerIds: [w.customerId] }) },
  {
    area: 'sales',
    operation: 'billing-groups.update',
    input: async (w) => on(await w.make('billing-groups.create', body({ name: w.unique('Quarterly clients') })), { name: w.unique('Quarterly clients'), customerIds: [w.customerId] }),
  },
  // A commission rate is a fraction (0.05 is 5%).
  { area: 'sales', operation: 'sales-reps.create', input: async (w) => body({ name: w.unique('Rita Rep'), email: 'rita@parity.test', commissionRate: '0.05' }) },
  {
    area: 'sales',
    operation: 'sales-reps.update',
    input: async (w) => on(await w.make('sales-reps.create', body({ name: w.unique('Rob Rep') })), { name: w.unique('Rob Rep'), commissionRate: '0.075' }),
  },
  {
    area: 'sales',
    operation: 'pricing.rules.create',
    input: async (w) => body({ name: w.unique('Consulting 10 off'), conditions: { itemIds: [w.serviceItemId] }, adjustment: { method: 'percent', value: '10' } }),
  },
  {
    area: 'sales',
    operation: 'pricing.rules.update',
    input: async (w) =>
      on(await w.make('pricing.rules.create', body({ name: w.unique('Consulting 5 off'), conditions: { itemIds: [w.serviceItemId] }, adjustment: { method: 'percent', value: '5' } })), {
        name: w.unique('Consulting 6 off'),
        conditions: { itemIds: [w.serviceItemId] },
        adjustment: { method: 'percent', value: '6' },
      }),
  },
  { area: 'lists', operation: 'type-lists.action', label: 'customer type', input: async (w) => ({ params: { kind: 'customer' }, body: { name: w.unique('Retail') } }) },
  {
    area: 'lists',
    operation: 'type-lists.update',
    label: 'vendor type',
    input: async (w) => {
      const id = await w.make('type-lists.action', { params: { kind: 'vendor' }, body: { name: w.unique('Supplier') } });
      return { params: { kind: 'vendor', id }, body: { name: w.unique('Main supplier') } };
    },
  },
  { area: 'lists', operation: 'lists.action', label: 'ship via', input: async (w) => ({ params: { list: 'ship-via' }, body: { name: w.unique('Courier') } }) },
  {
    area: 'lists',
    operation: 'type-lists.vendor-assign',
    input: async (w) =>
      body({
        vendorId: await w.make('vendors.create', body({ displayName: w.unique('Typed vendor') })),
        vendorTypeId: await w.make('type-lists.action', { params: { kind: 'vendor' }, body: { name: w.unique('Wholesaler') } }),
      }),
  },
  {
    area: 'lists',
    operation: 'job-type-assign',
    input: async (w) =>
      body({
        jobId: await w.make('jobs.create', body({ name: w.unique('Porch'), customerId: w.customerId })),
        jobTypeId: await w.make('lists.action', { params: { list: 'job-types' }, body: { name: w.unique('Remodel') } }),
      }),
  },
  {
    area: 'lists',
    operation: 'billing-rate-levels.assign',
    input: async (w) =>
      body({
        employeeId: await w.make('employees.create', body({ firstName: 'Bea', lastName: w.unique('Parity'), payType: 'hourly', payRate: '25.00' })),
        levelId: await w.make('billing-rate-levels.create', body({ name: w.unique('Standard rate'), type: 'fixed_rate', fixedRate: '95.00' })),
      }),
  },
  {
    area: 'sales',
    operation: 'pricing.levels.items.update',
    input: async (w) => on(await w.make('pricing.levels.create', body({ name: w.unique('Per item'), type: 'per_item' })), { items: [{ itemId: w.serviceItemId, price: '115.00' }] }),
  },
  {
    area: 'sales',
    operation: 'pricing.customers.update',
    input: async (w) =>
      on(await w.make('customers.create', body({ displayName: w.unique('Priced customer') })), {
        priceLevelId: await w.make('pricing.levels.create', body({ name: w.unique('Friends'), type: 'fixed_percent', percent: '15' })),
      }),
  },
  {
    area: 'sales',
    operation: 'sales-reps.assign',
    input: async (w) => body({ invoiceId: (await openInvoice(w)).id, salesRepId: await w.make('sales-reps.create', body({ name: w.unique('Sam Rep') })) }),
  },
  {
    area: 'sales',
    operation: 'sales-forms.flags.update',
    label: 'invoice to print',
    input: async (w) => ({ params: { kind: 'invoice', id: (await openInvoice(w)).id }, body: { toBePrinted: true, toBeEmailed: false } }),
  },
  {
    area: 'banking',
    operation: 'bank-rules.reorder',
    input: async (w) => {
      const a = await w.make('bank-rules.create', body(bankRuleBody(w, 'FUEL')));
      const b = await w.make('bank-rules.create', body(bankRuleBody(w, 'PARKING')));
      // Every rule of the company (bank rules are rows of transaction_rules), the two new ones swapped at the end.
      const companyId = await w.valueOf('transaction_rules', a, 'company_id');
      const all = (await w.idsWhere('transaction_rules', 'company_id', companyId ?? '')).filter((id) => id !== a && id !== b);
      return body({ orderedIds: [...all, b, a] });
    },
  },
  {
    area: 'inventory',
    operation: 'inventory-sites.reorder-points.update',
    input: async (w) => body({ itemId: w.inventoryItemId, siteId: await w.make('inventory-sites.create', body({ name: w.unique('Kiosk') })), reorderPoint: '5', maxQuantity: '50' }),
  },
  { area: 'lists', operation: 'letters.templates.create', input: async (w) => body({ category: 'customer', name: w.unique('Thank you'), body: 'Dear customer, thank you for your business.' }) },
  {
    area: 'lists',
    operation: 'letters.templates.update',
    input: async (w) =>
      on(await w.make('letters.templates.create', body({ category: 'collection', name: w.unique('Reminder'), body: 'Your balance is past due.' })), { body: 'Your balance is past due. Please call us.' }),
  },

  // --- Purchases, more: expense reports, landed cost ---
  { area: 'purchases', operation: 'expense-reports.create', input: async (w) => body(expenseReportBody(w)) },
  {
    area: 'purchases',
    operation: 'expense-reports.action',
    label: 'submit',
    input: async (w) => on(await w.make('expense-reports.create', body(expenseReportBody(w))), { action: 'submit' }),
  },
  {
    area: 'purchases',
    operation: 'expense-reports.action',
    label: 'reimburse',
    input: async (w) => {
      const id = await w.make('expense-reports.create', body(expenseReportBody(w)));
      await w.commit('expense-reports.action', on(id, { action: 'submit' }));
      return on(id, { action: 'reimburse', bankAccountId: w.acct['1000'] });
    },
  },
  {
    area: 'purchases',
    operation: 'landed-cost.create',
    input: async (w) => {
      const receipt = await w.make('item-receipts.create', body(receiptBody(w, '5')));
      const bill = await w.make('bills.create', body({ vendorId: w.vendorId, date: D, lines: [{ accountId: w.acct['5000'], description: 'Freight in', amount: '30.00' }] }));
      const [billLineId] = await w.idsWhere('bill_lines', 'bill_id', bill);
      return body({ billId: bill, billLineId, method: 'quantity', itemReceiptIds: [receipt], date: D, memo: 'Freight on widgets' });
    },
  },

  // --- Banking, more: a bank account, its feed, rules ---
  { area: 'banking', operation: 'bank-accounts.create', input: async (w) => body({ accountId: await newBankGl(w), bankName: 'Parity Bank', accountNumber: '000123456789' }) },
  {
    area: 'banking',
    operation: 'demo-feed',
    input: async (w) => body({ bankAccountId: await newBankAccount(w) }),
    // lib/services/demoFeed.ts inserts the sample transactions with no audit row, and posts nothing:
    // the dry run's preview is empty (no entry, no record), yet the real run adds 8 rows to
    // bank_transactions. A person approving it is shown nothing of what it does.
    fails: [/^records: the dry run shows nothing, the real run changed bank_transactions \(\d+ rows -> \d+ rows\) and wrote no audit row$/],
  },
  {
    area: 'banking',
    operation: 'bank-transactions.categorize',
    input: async (w) => body({ bankTransactionId: await fedTransaction(w), accountId: w.acct['6300'], payee: 'Paper Supply Co', memo: 'From the feed' }),
  },
  { area: 'banking', operation: 'bank-transactions.exclude', input: async (w) => body({ bankTransactionId: await fedTransaction(w) }) },
  { area: 'banking', operation: 'bank-rules.create', input: async (w) => body(bankRuleBody(w, 'COFFEE')) },
  { area: 'banking', operation: 'bank-rules.update', input: async (w) => on(await w.make('bank-rules.create', body(bankRuleBody(w, 'TONER'))), { matchValue: 'TONER CARTRIDGE', setMemo: 'Printer ink' }) },
  { area: 'banking', operation: 'rules.create', input: async (w) => body({ name: w.unique('Uber rides'), matchField: 'payee', matchOperator: 'contains', matchValue: 'Uber', setAccountId: w.acct['6600'] }) },

  // --- Inventory, more: a count, bins, a transfer between sites ---
  {
    area: 'inventory',
    operation: 'inventory.physical-count',
    input: async (w) => body({ itemId: await w.make('items.create', body(gadgetBody(w, '10'))), countedQty: '8', date: D }),
  },
  {
    area: 'inventory',
    operation: 'inventory-sites.bins.create',
    input: async (w) => body({ siteId: await w.make('inventory-sites.create', body({ name: w.unique('Aisle') })), name: 'A-1' }),
  },
  {
    area: 'inventory',
    operation: 'inventory-sites.bins.update',
    input: async (w) => {
      const siteId = await w.make('inventory-sites.create', body({ name: w.unique('Aisle') }));
      return on(await w.make('inventory-sites.bins.create', body({ siteId, name: 'B-1' })), { name: 'B-2' });
    },
  },
  { area: 'inventory', operation: 'inventory-transfers.create', input: async (w) => body(await transferBetweenSites(w)) },
  {
    area: 'inventory',
    operation: 'inventory-transfers.action',
    label: 'void',
    input: async (w) => on(await w.make('inventory-transfers.create', body(await transferBetweenSites(w))), { action: 'void' }),
  },

  // --- Planning and payroll set-up, more ---
  {
    area: 'planning',
    operation: 'recurring.update',
    input: async (w) =>
      on(await w.make('recurring.create', body({ name: w.unique('Monthly rent'), docType: 'journal_entry', frequency: 'monthly', nextRunDate: '2026-04-01', mode: 'remind', template: journalBody(w, '1200.00') })), {
        frequency: 'quarterly',
        daysInAdvance: 5,
      }),
  },
  {
    area: 'payroll',
    operation: 'payroll-items.update',
    input: async (w) =>
      on(await w.make('payroll-items.create', body({ name: w.unique('Parking deduction'), kind: 'deduction', liabilityAccountId: w.acct['2300'], calcBasis: 'fixed', defaultRate: '20.00' })), {
        defaultRate: '22.50',
      }),
  },

  // --- Payroll: a paycheck, its edit and void, adjustments, paying the liabilities ---
  {
    area: 'payroll',
    operation: 'payroll.update',
    input: async (w) => on(await w.make('payroll.create', body(paycheckBody(w, '10'))), paycheckBody(w, '12', false)),
  },
  { area: 'payroll', operation: 'payroll.delete', input: async (w) => on(await w.make('payroll.create', body(paycheckBody(w, '8')))) },
  {
    area: 'payroll',
    operation: 'payroll.adjustments.create',
    label: 'liability',
    input: async (w) =>
      body({ type: 'liability', employeeId: w.employeeId, date: D, memo: 'Fix withholding', lines: [{ kind: 'tax', name: 'Federal Withholding', amount: '10.00' }], affectsAccounts: true, offsetAccountId: w.acct['6500'] }),
    // lib/services/payrollAdjustments.ts posts the entry with reference pc.id.slice(0, 8): the first
    // eight characters of the new adjustment row's id. The bridge's staleness key reads the
    // reference (stalenessKeyOf) and puts aside only WHOLE new ids (keyValue), so every dry run
    // gives another key. The preview does not show the reference. Ledger, records and amount agree.
    fails: [keyMoved(PREVIEWS_AGREE)],
    approverFails: approverKeyMoved(PREVIEWS_AGREE),
  },
  {
    area: 'payroll',
    operation: 'payroll.adjustments.create',
    label: 'year to date',
    input: async (w) => body(ytdAdjustmentBody(w)),
    // The same reference as the liability adjustment above. And the amount: amountField
    // 'lines.*.amount' adds every line, the 2000.00 earning and the 200.00 withholding taken out
    // of it, so the facts say 2200.00 where the entry posts 2000.00 (Dr wages 2000.00, Cr bank
    // 1800.00, Cr liabilities 200.00). Larger, so no limit is missed, but not what was posted.
    fails: [keyMoved(PREVIEWS_AGREE), /^amount: the dry run says 2200\.00, the real run posted 2000\.00$/],
    approverFails: approverKeyMoved(PREVIEWS_AGREE),
  },
  { area: 'payroll', operation: 'payroll.adjustments.delete', input: async (w) => on(await w.make('payroll.adjustments.create', body(ytdAdjustmentBody(w)))) },
  {
    area: 'payroll',
    operation: 'pay-liabilities.checks.action',
    label: 'void',
    input: async (w) => {
      await w.make('payroll.create', body(paycheckBody(w, '5')));
      // The answer is the entry ({ entry }); the check is the payment_checks row that posted it.
      const entry = await w.make('pay-liabilities.pay', body({ type: 'payroll', amount: '12.00', date: D, paymentAccountId: w.acct['1000'], payeeName: 'US Treasury' }));
      const [check] = await w.idsWhere('payment_checks', 'posted_entry_id', entry);
      if (!check) throw new Error('The liability payment made no check');
      return on(check, { action: 'void' });
    },
  },

  // --- Inventory and purchases, more: FIFO layers, voiding a landed cost ---
  { area: 'inventory', operation: 'fifo.adjust', label: 'receive', input: async (w) => body({ action: 'receive', itemId: w.inventoryItemId, quantity: '2', unitCost: '4.25', date: D, memo: 'Two more from the supplier' }) },
  {
    area: 'purchases',
    operation: 'landed-cost.action',
    label: 'void',
    input: async (w) => {
      const receipt = await w.make('item-receipts.create', body(receiptBody(w, '5')));
      const bill = await w.make('bills.create', body({ vendorId: w.vendorId, date: D, lines: [{ accountId: w.acct['5000'], description: 'Freight in', amount: '20.00' }] }));
      const [billLineId] = await w.idsWhere('bill_lines', 'bill_id', bill);
      return on(await w.make('landed-cost.create', body({ billId: bill, billLineId, method: 'quantity', itemReceiptIds: [receipt], date: D })), { action: 'void' });
    },
  },

  // --- Banking, more: matching a fed transaction, undoing it, reconciliation work ---
  {
    area: 'banking',
    operation: 'bank-transactions.match',
    input: async (w) => {
      const f = await fed(w);
      return body({ bankTransactionId: f.id, journalEntryId: await entryForFeed(w, f) });
    },
  },
  {
    area: 'banking',
    operation: 'bank-transactions.unmatch',
    label: 'after categorize',
    input: async (w) => {
      const id = await fedTransaction(w);
      await w.commit('bank-transactions.categorize', body({ bankTransactionId: id, accountId: w.acct['6300'] }));
      return body({ bankTransactionId: id });
    },
  },
  {
    area: 'banking',
    operation: 'reconciliations.update',
    label: 'service charge',
    input: async (w) => on(await openReconciliation(w), { action: 'adjustments', serviceCharge: { amount: '9.00', accountId: w.acct['6100'] } }),
  },
  {
    area: 'banking',
    operation: 'reconciliations.update',
    label: 'statement',
    input: async (w) => on(await openReconciliation(w), { action: 'updateStatement', statementBalance: '0.00', statementDate: '2026-03-30' }),
  },

  // --- Sales tax: paying an agency, voiding the check, an adjustment ---
  {
    area: 'sales',
    operation: 'sales-tax.payments.create',
    input: async (w) => body({ date: D, paymentAccountId: w.acct['1000'], payments: [{ agencyId: await taxAgency(w), amount: '25.00' }], memo: 'February sales tax' }),
  },
  {
    area: 'sales',
    operation: 'sales-tax.payments.action',
    label: 'void',
    input: async (w) => {
      const answer = await w.commit('sales-tax.payments.create', body({ date: D, paymentAccountId: w.acct['1000'], payments: [{ agencyId: await taxAgency(w), amount: '18.00' }] }));
      return on(await checkOf(w, answer), { action: 'void' });
    },
  },
  {
    area: 'accounting',
    operation: 'accountant.sales-tax.adjustments',
    input: async (w) => body({ date: D, agencyId: await taxAgency(w), amount: '3.00', direction: 'reduce', adjustmentAccountId: w.acct['4900'], reason: 'rounding', memo: 'Vendor discount for paying on time' }),
    // lib/services/accountant/salesTaxTools.ts writes an audit 'create' of kind
    // sales_tax_adjustment whose id IS the new journal entry's id. The bridge's staleness key
    // (stalenessKeyOf) maps each new id to one kind only: the ledger's 'new:journal_entry'
    // overwrites 'new:sales_tax_adjustment', so that record's id is not taken for the run's own
    // (isNew compares the kind) and stays in the key as it is: every dry run gives another key.
    // Ledger, records and amount agree.
    fails: [keyMoved(PREVIEWS_AGREE)],
    approverFails: approverKeyMoved(PREVIEWS_AGREE),
  },

  // --- Applying general journal credits ---
  {
    area: 'sales',
    operation: 'payments.journal-items.apply',
    label: 'credit to an invoice',
    input: async (w) => {
      const inv = await openInvoice(w);
      return body({ action: 'apply_credit', journalLineId: await customerCreditLine(w), invoiceId: inv.id, amount: '50.00', date: D });
    },
    // lib/services/journalApplications.ts records the application in a row of its own and writes
    // an audit 'update' on the journal entry naming it (newValues.applicationId), with no audit
    // 'create' for the application. Two differences follow: the key reads the new id (two dry runs
    // never agree), and the bridge (touchedEntries) lists the general journal entry as "Changed by
    // this request" when its row and lines stay exactly as they were. Records and amount agree.
    fails: [keyMoved(/journal_entry\.applicationId: /), /^ledger: the dry run shows entry [0-9a-f-]{36} as "Changed by this request: Goodwill credit", the real run left it as it was$/],
    approverFails: approverKeyMoved(/journal_entry\.applicationId: /),
  },
  {
    area: 'purchases',
    operation: 'bill-payments.journal-items.apply',
    label: 'credit to a bill',
    input: async (w) => body({ action: 'apply_credit', journalLineId: await vendorCreditLine(w), billId: await openBill(w), amount: '40.00', date: D }),
    // As payments.journal-items.apply above, on the vendor side.
    fails: [keyMoved(/journal_entry\.applicationId: /), /^ledger: the dry run shows entry [0-9a-f-]{36} as "Changed by this request: Vendor credit by letter", the real run left it as it was$/],
    approverFails: approverKeyMoved(/journal_entry\.applicationId: /),
  },
  {
    area: 'payroll',
    operation: 'pay-liabilities.pay',
    input: async (w) => {
      await w.make('payroll.create', body(paycheckBody(w, '6')));
      return body({ type: 'payroll', amount: '15.00', date: D, paymentAccountId: w.acct['1000'], payeeName: 'US Treasury', memo: 'Withholding' });
    },
  },

  // --- Money moved by the later screens: retainage, liabilities by item, a card balance, FX ---
  {
    area: 'sales',
    operation: 'invoices.retainage.bill',
    input: async (w) => {
      // A customer of its own, so the retainage held (10% of a 340.00 invoice) is this case's alone.
      const customerId = await w.make('customers.create', body({ displayName: w.unique('Retainage client') }));
      await w.make('invoices.create', body({ ...invoiceBody(w, '150.00', customerId), retainagePercent: '10' }));
      return body({ customerId, date: D, amount: '20.00', memo: 'Retainage released' });
    },
    // lib/services/retainage.ts billRetainage writes an audit 'create' of kind retainage_billing
    // whose id IS the new invoice's id, beside the invoice's own 'create'. As with the sales tax
    // adjustment above, the bridge's staleness key (stalenessKeyOf) maps each new id to one kind
    // only, so one of the two records keeps its raw id in the key: every dry run gives another
    // key. Ledger, records and amount agree.
    fails: [keyMoved(PREVIEWS_AGREE)],
    approverFails: approverKeyMoved(PREVIEWS_AGREE),
  },
  {
    area: 'payroll',
    operation: 'pay-liabilities.by-item.pay',
    input: async (w) => {
      await w.make('payroll.create', body(paycheckBody(w, '7')));
      return body({ date: D, paymentAccountId: w.acct['1000'], payeeName: 'US Treasury', memo: 'Withholding by item', items: [{ name: 'Federal Withholding', amount: '12.50' }] });
    },
  },
  {
    area: 'banking',
    operation: 'reconciliations.pay',
    input: async (w) => on(await completedCardReconciliation(w), { paymentAccountId: w.acct['1000'], amount: '75.00', date: D, memo: 'Card balance' }),
  },
  {
    area: 'accounting',
    operation: 'currencies.fx-adjustment',
    input: async (w) => body({ accountId: w.acct['1010'], amount: '12.34', gain: true, date: D, memo: 'Revalued at month end' }),
    // The company's first FX adjustment (the only case that makes one): lib/services/currencies.ts
    // makes the Exchange Gain/Loss account (6900) on first use, with no audit row. Each run makes
    // its own, with an id of its own, and the key reads that id in the ledger lines: two dry runs
    // never agree, as with the first item receipt's accrual account. Ledger (the account by code
    // and name), records and amount agree.
    fails: [keyMoved(/Exchange Gain\/Loss/)],
    approverFails: approverKeyMoved(/Exchange Gain\/Loss/),
  },

  // --- Assemblies: the bill of materials, a build, a pending build ---
  {
    area: 'inventory',
    operation: 'assemblies.replace',
    input: async (w) => {
      const { assemblyItemId, componentItemId } = await assemblyItems(w);
      return body({ assemblyItemId, components: [{ componentItemId, quantity: '2' }] });
    },
  },
  {
    area: 'inventory',
    operation: 'assemblies.update',
    input: async (w) => {
      const { assemblyItemId, componentItemId } = await assemblyItems(w);
      await w.commit('assemblies.replace', body({ assemblyItemId, components: [{ componentItemId, quantity: '2' }] }));
      return body({ assemblyItemId, components: [{ componentItemId, quantity: '3' }] });
    },
  },
  {
    area: 'inventory',
    operation: 'assemblies.build',
    input: async (w) => body({ assemblyItemId: await assemblyWithBom(w), quantity: '2', action: 'build', date: D }),
    // lib/services/assemblies.ts tags the value-move entry with sourceRef
    // "assembly_build:<buildId>:…", where buildId is a randomUUID() of each run that names no row
    // (so no audit 'create' either). The bridge's staleness key reads the source and keeps that id
    // as it is: every dry run gives another key. The preview shows the source, so the two previews
    // differ there too. Ledger, records and amount agree with the real run.
    fails: [keyMoved(/"source":"assembly_build:/)],
    approverFails: approverKeyMoved(/"source":"assembly_build:/),
  },
  {
    area: 'inventory',
    operation: 'assemblies.pending.create',
    input: async (w) => body({ assemblyItemId: await assemblyWithBom(w), quantity: '1', date: D, memo: 'For the next order' }),
  },
  {
    area: 'inventory',
    operation: 'assemblies.pending.action',
    label: 'finalize',
    input: async (w) => {
      const pending = await w.make('assemblies.pending.create', body({ assemblyItemId: await assemblyWithBom(w), quantity: '1', date: D }));
      return on(pending, { action: 'finalize' });
    },
    // Finalizing builds it (buildAssembly): the same new build id in the entry's source as above.
    fails: [keyMoved(/"source":"assembly_build:/)],
    approverFails: approverKeyMoved(/"source":"assembly_build:/),
  },
];

// ---------------------------------------------------------------------------
// Helpers of the later cases
// ---------------------------------------------------------------------------

function loanPaymentBody(w: ParityWorld): Obj {
  return { kind: 'check', date: '2026-02-01', paymentAccountId: w.acct['1000'], principal: '220.00', interest: '65.00' };
}

function expenseReportBody(w: ParityWorld): Obj {
  return { employeeId: w.employeeId, title: w.unique('Trip to the client'), lines: [{ accountId: w.acct['6300'], date: D, description: 'Taxi', amount: '35.00' }] };
}

function bankRuleBody(w: ParityWorld, match: string): Obj {
  return { name: w.unique(`Rule ${match}`), matchField: 'description', matchOperator: 'contains', matchValue: match, setAccountId: w.acct['6300'], mode: 'suggest' };
}

function gadgetBody(w: ParityWorld, quantity: string): Obj {
  return {
    name: w.unique('Parity gizmo'),
    type: 'inventory',
    salesPrice: '20.00',
    purchaseCost: '8.00',
    incomeAccountId: w.acct['4000'],
    expenseAccountId: w.acct['5000'],
    assetAccountId: w.acct['1300'],
    openingQuantity: quantity,
    openingUnitCost: '8.00',
    openingAsOf: '2026-01-02',
  };
}

/** A bank account of the chart of its own (each bank-feed link needs one). */
async function newBankGl(w: ParityWorld): Promise<string> {
  // Codes 17nn are free in the parity company's chart; the counter makes each one new.
  const name = w.unique('Feed checking');
  return w.make('accounts.create', body({ code: `17${name.split(' ').pop()!.padStart(2, '0')}`, name, type: 'asset', subtype: 'checking' }));
}

async function newBankAccount(w: ParityWorld): Promise<string> {
  return w.make('bank-accounts.create', body({ accountId: await newBankGl(w), bankName: 'Parity Bank', accountNumber: '000987654321' }));
}

/** One transaction of a sample feed loaded into a bank account of its own. */
async function fedTransaction(w: ParityWorld): Promise<string> {
  return (await fed(w)).id;
}

/**
 * The first money-out transaction of a sample feed (by its feed id, so every run of the test picks
 * the same sample: row ids are random), loaded into a bank account of its own.
 */
async function fed(w: ParityWorld): Promise<{ id: string; bankAccountId: string; glAccountId: string; amount: string }> {
  const bankAccountId = await newBankAccount(w);
  await w.commit('demo-feed', body({ bankAccountId }));
  const rows: Array<{ id: string; fitId: string; amount: string }> = [];
  for (const id of await w.idsWhere('bank_transactions', 'bank_account_id', bankAccountId)) {
    const amount = await w.valueOf('bank_transactions', id, 'amount');
    if (amount !== null && Money.isNegative(amount)) rows.push({ id, amount, fitId: (await w.valueOf('bank_transactions', id, 'fit_id')) ?? '' });
  }
  rows.sort((a, b) => a.fitId.localeCompare(b.fitId));
  const [first] = rows;
  if (!first) throw new Error('The sample feed loaded no money-out transaction');
  const glAccountId = await w.valueOf('bank_accounts', bankAccountId, 'account_id');
  if (!glAccountId) throw new Error('The bank account names no account of the chart');
  return { id: first.id, bankAccountId, glAccountId, amount: first.amount };
}

/** A posted journal entry that moves exactly the fed amount through the bank's own account. */
async function entryForFeed(w: ParityWorld, f: { glAccountId: string; amount: string }): Promise<string> {
  const size = toAmountString(Money.abs(f.amount));
  const out = Money.isNegative(f.amount);
  return w.make(
    'journal-entries.create',
    body({
      date: D,
      description: 'Entered by hand before the feed came in',
      lines: out
        ? [
            { accountId: w.acct['6300'], debit: size },
            { accountId: f.glAccountId, credit: size },
          ]
        : [
            { accountId: f.glAccountId, debit: size },
            { accountId: w.acct['4900'], credit: size },
          ],
    }),
  );
}

/** The line of a journal entry on this account. */
async function lineOn(w: ParityWorld, entryId: string, accountId: string): Promise<string> {
  for (const id of await w.idsWhere('journal_entry_lines', 'journal_entry_id', entryId)) {
    if ((await w.valueOf('journal_entry_lines', id, 'account_id')) === accountId) return id;
  }
  throw new Error(`Entry ${entryId} has no line on account ${accountId}`);
}

/** A general journal credit to the customer (A/R), as a discount given by hand. */
async function customerCreditLine(w: ParityWorld): Promise<string> {
  const je = await w.make(
    'journal-entries.create',
    body({
      date: D,
      description: 'Goodwill credit',
      lines: [
        { accountId: w.acct['4000'], debit: '50.00' },
        { accountId: w.acct['1200'], credit: '50.00', entityType: 'customer', entityId: w.customerId },
      ],
    }),
  );
  return lineOn(w, je, w.acct['1200']);
}

/** A general journal debit to the vendor (A/P), a credit the vendor gave by letter. */
async function vendorCreditLine(w: ParityWorld): Promise<string> {
  const je = await w.make(
    'journal-entries.create',
    body({
      date: D,
      description: 'Vendor credit by letter',
      lines: [
        { accountId: w.acct['2000'], debit: '40.00', entityType: 'vendor', entityId: w.vendorId },
        { accountId: w.acct['6300'], credit: '40.00' },
      ],
    }),
  );
  return lineOn(w, je, w.acct['2000']);
}

/** A sales tax agency of its own, owed through Sales Tax Payable. */
async function taxAgency(w: ParityWorld): Promise<string> {
  return w.make('tax-agencies.create', body({ name: w.unique('State Revenue Dept'), liabilityAccountId: w.acct['2200'] }));
}

/** The payment_checks row behind a payment's answer: the answer names the check, or the entry the check posted. */
async function checkOf(w: ParityWorld, answer: Obj): Promise<string> {
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) seen.add(v.toLowerCase());
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (isObj(v)) Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(answer, 0);
  for (const id of seen) {
    if ((await w.valueOf('payment_checks', id, 'id')) !== null) return id;
    const [check] = await w.idsWhere('payment_checks', 'posted_entry_id', id);
    if (check) return check;
  }
  throw new Error(`The answer names no check: ${JSON.stringify(answer).slice(0, 300)}`);
}

/** A reconciliation in progress, on a bank account of its own (one at a time per account). */
async function openReconciliation(w: ParityWorld): Promise<string> {
  return w.make('reconciliations.create', body({ bankAccountId: await newBankAccount(w), statementDate: '2026-03-31', statementBalance: '0.00' }));
}

/** An account code of the chart that no account has yet: `prefix` and two digits. */
async function freeCode(w: ParityWorld, prefix: string): Promise<string> {
  for (let i = 1; i < 100; i++) {
    const code = `${prefix}${String(i).padStart(2, '0')}`;
    if (!(await w.idsWhere('accounts', 'code', code)).length) return code;
  }
  throw new Error(`No free account code starting ${prefix}`);
}

/**
 * A completed reconciliation of a credit card of its own (Pay Credit Card is offered only after
 * one): a new card account with nothing on it, its statement at 0.00, so it completes as it is.
 */
async function completedCardReconciliation(w: ParityWorld): Promise<string> {
  const card = await w.make('accounts.create', body({ code: await freeCode(w, '27'), name: w.unique('Parity card'), type: 'liability', subtype: 'credit_card' }));
  const bankAccountId = await w.make('bank-accounts.create', body({ accountId: card, bankName: 'Parity Card Co', accountNumber: '000555666777' }));
  const recon = await w.make('reconciliations.create', body({ bankAccountId, statementDate: '2026-02-28', statementBalance: '0.00' }));
  await w.commit('reconciliations.update', on(recon, { action: 'complete' }));
  return recon;
}

/** An inventory item to build, with nothing on hand, and a component of its own with 10 on hand. */
async function assemblyItems(w: ParityWorld): Promise<{ assemblyItemId: string; componentItemId: string }> {
  const componentItemId = await w.make('items.create', body(gadgetBody(w, '10')));
  const assemblyItemId = await w.make(
    'items.create',
    body({ name: w.unique('Parity kit'), type: 'inventory', salesPrice: '45.00', incomeAccountId: w.acct['4000'], expenseAccountId: w.acct['5000'], assetAccountId: w.acct['1300'] }),
  );
  return { assemblyItemId, componentItemId };
}

/** An assembly whose bill of materials takes 2 of its own component. */
async function assemblyWithBom(w: ParityWorld): Promise<string> {
  const { assemblyItemId, componentItemId } = await assemblyItems(w);
  await w.commit('assemblies.replace', body({ assemblyItemId, components: [{ componentItemId, quantity: '2' }] }));
  return assemblyItemId;
}

function ytdAdjustmentBody(w: ParityWorld): Obj {
  return {
    type: 'ytd',
    employeeId: w.employeeId,
    date: D,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    memo: 'January paid elsewhere',
    lines: [
      { kind: 'earning', name: 'Regular pay', amount: '2000.00' },
      { kind: 'tax', name: 'Federal Withholding', amount: '200.00' },
    ],
    affectsAccounts: true,
    bankAccountId: w.acct['1000'],
  };
}

/** 4 widgets from the default site to a site of its own (the default site holds the stock). */
async function transferBetweenSites(w: ParityWorld): Promise<Obj> {
  // A site adjustment with no site lands on the default site, making it on first use.
  await w.commit('inventory-sites.adjust', body({ itemId: w.inventoryItemId, quantityChange: '-1', date: D, memo: 'Shop sample' }));
  const [fromSiteId] = await w.idsWhere('inventory_sites', 'is_default', 'true');
  const toSiteId = await w.make('inventory-sites.create', body({ name: w.unique('Van stock') }));
  return { date: D, fromSiteId, toSiteId, memo: 'Stock for the van', lines: [{ itemId: w.inventoryItemId, quantity: '4' }] };
}

/** A paycheck of hours at the employee's rate, with withholding. */
function paycheckBody(w: ParityWorld, hours: string, withEmployee = true): Obj {
  return {
    ...(withEmployee ? { employeeId: w.employeeId } : {}),
    payDate: D,
    periodStart: '2026-02-16',
    periodEnd: '2026-02-28',
    earnings: [{ kind: 'regular', hours, rate: '30.00' }],
    taxes: [{ kind: 'tax', name: 'Federal Withholding', amount: '20.00' }],
  };
}
