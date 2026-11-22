/**
 * The named tools for everyday entry the first named tools did not cover (plan §9, Phase 1):
 * estimates and the invoice made from one, purchase orders and receiving the items, credit memos,
 * vendor credits, time, inventory adjustments, and paying sales tax.
 *
 * Each is a thin wrapper over one operation of the generic door (run_operation,
 * mcp/operations-tools.mjs): the tool's snake_case arguments become the operation's own body, in
 * the app's camelCase names (lib/validation/*), and the door's answer comes back shaped as
 * run_operation shapes it: read / dry_run / posted / done / asked / needs_confirmation / refused.
 * dry_run, request_id, reason and confirm mean what they mean on run_operation. Nothing here
 * decides anything: the policy, the approvals and the request ids are the door's.
 *
 * Each tool names the operations it runs in `operations`. test/mcp/entryTools.test.ts holds those
 * ids to the registry, so an operation renamed in the app fails a test instead of an agent's work.
 * Anything without a named tool (applying a credit, billing received items, voiding, emailing,
 * 1099s, paystubs …) is one find_operations away.
 */
import { ToolError } from './protocol.mjs';
// A namespace import: the door's helpers are another unit's, and a helper that is not there yet
// must not stop the connector from starting (see fit).
import * as door from './operations-tools.mjs';
import { camelize, settle } from './write-tools.mjs';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', patternHint: 'must be a date as YYYY-MM-DD' };
const ID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', patternHint: 'must be an id returned by another tool' };
const MONEY = { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,2})?$', patternHint: 'must be an amount like 1250.00 (text, at most 2 decimals)' };
/** A quantity, price or rate: text, may be negative (a discount line), up to 6 decimals. */
const QTY = { type: 'string', pattern: '^-?\\d{1,13}(\\.\\d{1,6})?$', patternHint: 'must be a number like 2 or 1.5 (as text)' };
/** The same, never below zero. */
const POSITIVE = { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,6})?$', patternHint: 'must be a number like 2 or 1.5 (as text, not negative)' };
const PERCENT = { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,4})?$', patternHint: 'must be a percentage like 50 or 33.33 (as text)' };
const TEXT = (/** @type {number} */ max, /** @type {string} */ description) => ({ type: 'string', maxLength: max, description });

const DRY_RUN = {
  type: 'boolean',
  description: 'true: try it inside Ironbooks and show what it would post and change, keeping nothing. Do this first. No request_id is needed for a dry run.',
};
const REQUEST_ID = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:\\-]{2,119}$',
  patternHint: 'must be 3 to 120 letters, digits, dots, dashes, colons or underscores',
  description:
    'Your own name for this one change, for example "estimate-acme-2026-03-08". Required unless dry_run is true. Asking again with the same request_id returns the first answer and never does it twice; use a new one for each new change.',
};
const REASON = {
  type: 'string',
  maxLength: 500,
  description:
    'Why it is needed, in one or two plain sentences (at most 500 characters). Needed when a person must approve it: the person sees it labelled as your words, next to the preview Ironbooks builds itself.',
};

/** Same words as the other named tools (write-tools.mjs). */
const NEED_REQUEST_ID = 'Give a request_id (your own name for this one change), or set dry_run to true to only check it.';

/** The confirm argument of a tool whose operation accepts these flags after a warning. */
function confirmProp(/** @type {string[]} */ flags) {
  return {
    type: 'array',
    maxItems: 20,
    items: { type: 'string', enum: flags },
    description: `Warnings you accept, each named by an earlier needs_confirmation answer (${flags.join(', ')}). Send one only after reading that warning, and only when going ahead is right; a request sent with one may need a person to approve it.`,
  };
}

/**
 * Hold a shaped answer to the door's size limit, as run_operation does (operations-tools.mjs
 * holdToLimit). If that helper is missing, cut the longest lists instead (cutToFit).
 * @param {Record<string, unknown>} shaped
 */
export function fit(shaped) {
  if (typeof door.holdToLimit === 'function') return door.holdToLimit(shaped);
  const cut = typeof door.cutToFit === 'function' ? door.cutToFit(shaped) : null;
  if (!cut) return shaped;
  return cut.value
    ? { .../** @type {object} */ (cut.value), result_cut_short: 'The answer was too long to show in full: its longest lists were cut.' }
    : { outcome: shaped.outcome, said: shaped.said, next: shaped.next, result_cut_short: 'The answer was too long to show.' };
}

/**
 * Run one operation through the door: POST /api/agent/actions with { verb: 'run_operation', ... }
 * (lib/agent/contract.ts RunOperationRequest). A dry run is never filed under a request id.
 * @param {any} client
 * @param {{ operation: string, params?: Record<string, string>, query?: Record<string, string>, body?: unknown,
 *   confirm?: string[], dryRun?: boolean, requestId?: string, reason?: string }} req
 */
export function runOperation(client, req) {
  const { dryRun, requestId, reason, confirm, ...rest } = req;
  return door.verb(client, 'run_operation', {
    ...rest,
    confirm: Array.isArray(confirm) && confirm.length ? [...new Set(confirm)] : undefined,
    ...(dryRun === true ? { dryRun: true } : { requestId, reason }),
  });
}

/**
 * One named entry tool. `build` turns the tool's own arguments (dry_run, request_id, reason and
 * confirm taken out) into the operation and its input.
 * @param {{ name: string, title: string, description: string, operations: string[], confirm?: string[],
 *   properties: Record<string, object>, required?: string[], destructive?: boolean,
 *   build: (args: Record<string, any>) => { operation: string, params?: Record<string, string>, body: unknown } }} def
 */
function entryTool(def) {
  const flags = def.confirm ?? [];
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    operations: def.operations,
    changes: true,
    destructive: def.destructive === true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: def.required ?? [],
      properties: { ...def.properties, dry_run: DRY_RUN, request_id: REQUEST_ID, reason: REASON, ...(flags.length ? { confirm: confirmProp(flags) } : {}) },
    },
    handler: async (/** @type {Record<string, any>} */ args, /** @type {any} */ client) => {
      const { dry_run: dryRun, request_id: requestId, reason, confirm, ...rest } = args;
      if (dryRun !== true && !requestId) throw new ToolError(NEED_REQUEST_ID);
      const { operation, params, body } = def.build(rest);
      const answer = await runOperation(client, { operation, params, body, confirm, dryRun: dryRun === true, requestId, reason });
      // A warning's flag goes back in confirm when this tool takes it. The tool takes exactly the
      // operation's own flags (a test holds them together), and the door accepts no other, so any
      // other warning is answered as one to change the request for (write-tools.mjs resendWith).
      return fit(settle(answer, { confirm: flags }));
    },
  };
}

/** The tool's own arguments in the app's names, with "no sales tax" as the app says it (taxRateId null). */
function salesBody(/** @type {Record<string, any>} */ args) {
  const { no_sales_tax: noTax, ...rest } = args;
  const body = /** @type {Record<string, unknown>} */ (camelize(rest));
  if (noTax === true) {
    if (body.taxRateId) throw new ToolError('Give tax_rate_id or no_sales_tax, not both.');
    body.taxRateId = null;
  }
  return body;
}

// ---------------------------------------------------------------------------
// The parts the forms share
// ---------------------------------------------------------------------------

const TAX_RATE = { ...ID, description: "The sales tax item charged on taxable lines (list_other with list sales-tax-items). Leave out to use the customer's own; no_sales_tax true for none." };
const NO_SALES_TAX = { type: 'boolean', description: 'true: charge no sales tax on this form, whatever the customer usually pays.' };
const CUSTOMER_MESSAGE = { ...ID, description: 'A customer message printed at the foot of the form (list_other with list customer-messages).' };
const TO_BE_PRINTED = { type: 'boolean', description: 'Put the form in the queue of forms to print later. Nothing is printed now.' };
const TO_BE_EMAILED = { type: 'boolean', description: 'Put the form in the queue of forms to email later. Nothing is sent now.' };
const SHIP_TO = {
  type: 'object',
  additionalProperties: false,
  description: 'The ship-to address, line by line (each at most 255 characters).',
  properties: {
    name: TEXT(255, 'Name on the address.'),
    line1: TEXT(255, 'First street line.'),
    line2: TEXT(255, 'Second street line.'),
    city: TEXT(255, 'City.'),
    state: TEXT(255, 'State or province.'),
    zip: TEXT(255, 'ZIP or postal code.'),
    country: TEXT(255, 'Country.'),
  },
};
/** Where stock moves, for companies that use inventory sites, bins, serial or lot numbers. */
const STOCK_FIELDS = {
  site_id: { ...ID, description: "The inventory site the stock moves at. Leave out for the company's default site." },
  bin_id: { ...ID, description: 'A bin within that site, when the company uses bins.' },
  serial_numbers: { type: 'array', maxItems: 10000, items: { type: 'string', maxLength: 100 }, description: 'One serial number per unit; only for serial-tracked items.' },
  lot_number: TEXT(100, 'The lot number; only for lot-tracked items.'),
};
const LOT_EXPIRATION = { ...DATE, description: 'When the lot expires (YYYY-MM-DD); only when stock comes in.' };

const SALES_LINE = {
  type: 'object',
  additionalProperties: false,
  required: ['quantity'],
  properties: {
    item_id: { ...ID, description: 'The item (from list_items). It gives the price and the income account.' },
    description: TEXT(4000, 'Text printed on the line.'),
    quantity: { ...QTY, description: 'Quantity, as text ("1", "2.5").' },
    rate: { ...QTY, description: "Price each, as text (\"125.00\"). Leave out on an item line to use the price Ironbooks works out for this customer." },
    taxable: { type: 'boolean', description: 'Whether sales tax applies to the line (default true).' },
    sales_tax_code_id: { ...ID, description: 'A sales tax code ("Tax", "Non"; list_other with list sales-tax-codes). When given, it decides whether the line is taxable.' },
    class_id: { ...ID, description: 'Class, if the company tracks classes (list_classes).' },
  },
};

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/** @type {import('./protocol.mjs').Tool[]} */
export const ENTRY_TOOLS = [
  entryTool({
    name: 'enter_estimate',
    title: 'Enter an estimate',
    operations: ['estimates.create'],
    confirm: ['allowDuplicateNumber'],
    description:
      'Enter an estimate (a quote) for a customer. It posts nothing to the ledger: the answer is "done". Later it can be turned into an invoice with convert_estimate. The lines are like an invoice\'s: an item from list_items with a quantity, and a rate unless the item\'s own price is right. Check with search that the same estimate is not already there.',
    required: ['customer_id', 'date', 'lines'],
    properties: {
      customer_id: { ...ID, description: 'The customer (from list_customers).' },
      date: { ...DATE, description: 'Estimate date.' },
      expiration_date: { ...DATE, description: 'The day the estimate expires, if any.' },
      ref_number: TEXT(50, 'Estimate number. Leave out for the next number.'),
      tax_rate_id: TAX_RATE,
      no_sales_tax: NO_SALES_TAX,
      memo: TEXT(4000, 'Internal note (not printed).'),
      ship_to: SHIP_TO,
      customer_message_id: CUSTOMER_MESSAGE,
      to_be_printed: TO_BE_PRINTED,
      to_be_emailed: TO_BE_EMAILED,
      lines: { type: 'array', minItems: 1, maxItems: 500, items: SALES_LINE, description: 'What is quoted; at least one line.' },
    },
    build: (a) => ({ operation: 'estimates.create', body: salesBody(a) }),
  }),
  entryTool({
    name: 'convert_estimate',
    title: 'Turn an estimate into an invoice',
    operations: ['estimates.action'],
    confirm: ['overrideCreditLimit', 'allowOverBilling'],
    description:
      'Make an invoice from an estimate already entered: the whole estimate (to "invoice"), or part of it (to "progress_invoice", when the company uses progress invoicing): a percentage of every line, whatever is still unbilled, or chosen amounts per line. The invoice posts to Accounts Receivable and income. The estimate\'s line ids come from run_operation with operation "estimates.get" and params { "id": "<estimate id>" }. There is no tool to make a sales order from an estimate: enter the sales order with run_operation ("sales-orders.create"). Voiding an estimate is run_operation with "estimates.action" and body { "action": "void" }.',
    required: ['estimate_id'],
    properties: {
      estimate_id: { ...ID, description: 'The estimate (from search, or run_operation "estimates.list").' },
      to: { type: 'string', enum: ['invoice', 'progress_invoice'], description: 'invoice (default): one invoice for the whole estimate. progress_invoice: an invoice for part of it.' },
      percent: { ...PERCENT, description: 'progress_invoice only: bill this percentage of every line, as text ("50").' },
      remaining: { type: 'boolean', description: 'progress_invoice only: bill everything not billed yet.' },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        description: 'progress_invoice only: what to bill on chosen lines. Give one of percent, quantity or amount on each.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['line_id'],
          properties: {
            line_id: { ...ID, description: 'The estimate line.' },
            percent: { ...PERCENT, description: 'Bill this percentage of the line.' },
            quantity: { ...POSITIVE, description: 'Bill this quantity of the line.' },
            amount: { ...MONEY, description: 'Bill this amount of the line.' },
          },
        },
      },
      date: { ...DATE, description: 'progress_invoice only: the invoice date (default today).' },
    },
    build: (a) => {
      const to = a.to ?? 'invoice';
      const params = { id: a.estimate_id };
      const parts = ['percent', 'remaining', 'lines'].filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== false);
      if (to === 'invoice') {
        if (parts.length || a.date) throw new ToolError('percent, remaining, lines and date are only for to: "progress_invoice". To bill the whole estimate, leave them out.');
        return { operation: 'estimates.action', params, body: { action: 'convert' } };
      }
      if (parts.length !== 1) throw new ToolError('For a progress invoice give exactly one of percent, remaining or lines.');
      return {
        operation: 'estimates.action',
        params,
        body: camelize({ action: 'progress', percent: a.percent, remaining: a.remaining === true ? true : undefined, lines: a.lines, date: a.date }),
      };
    },
  }),
  entryTool({
    name: 'enter_purchase_order',
    title: 'Enter a purchase order',
    operations: ['purchase-orders.create'],
    confirm: ['allowDuplicateNumber'],
    description:
      'Enter a purchase order to a vendor: what the company orders, at what cost. It posts nothing to the ledger (the answer is "done"). When the goods come, receive them with receive_items (naming the order), or turn the order into a bill with run_operation "purchase-orders.action" and body { "action": "convert" }. Emailing it to the vendor is run_operation "purchase-orders.email": a person approves it first, unless a person gave you a standing permission to send it.',
    required: ['vendor_id', 'date', 'lines'],
    properties: {
      vendor_id: { ...ID, description: 'The vendor (from list_vendors).' },
      date: { ...DATE, description: 'Order date.' },
      expected_date: { ...DATE, description: 'When the goods are expected.' },
      ref_number: TEXT(50, 'Purchase order number. Leave out for the next number.'),
      memo: TEXT(4000, 'Internal note.'),
      ship_to: { ...SHIP_TO, description: "Where the vendor ships the goods. Leave out for the company's own address." },
      ship_to_customer_id: { ...ID, description: "Drop ship to this customer (their shipping address unless ship_to is given)." },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        description: 'What is ordered; at least one line. Each names an item, or an account when no item fits.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['quantity', 'rate'],
          properties: {
            item_id: { ...ID, description: 'The item ordered (from list_items). Inventory items go into stock when received or billed.' },
            account_id: { ...ID, description: 'The expense or asset account, when no item is given (from list_accounts).' },
            description: TEXT(4000, 'Text printed on the line.'),
            quantity: { ...POSITIVE, description: 'Quantity ordered, as text ("10").' },
            rate: { ...POSITIVE, description: 'Cost each, as text ("12.50").' },
            customer_id: { ...ID, description: 'A customer this purchase is for, carried onto the bill so it can be billed to them.' },
            job_id: { ...ID, description: "One of that customer's jobs." },
            class_id: { ...ID, description: 'Class, if used.' },
          },
        },
      },
    },
    build: (a) => ({ operation: 'purchase-orders.create', body: camelize(a) }),
  }),
  entryTool({
    name: 'receive_items',
    title: 'Receive items',
    operations: ['item-receipts.create'],
    description:
      'Record items that arrived before the vendor\'s bill (an item receipt). It puts them in stock and posts to inventory and an Item Receipts accrual, not to Accounts Payable. When the bill comes, turn the receipt into the bill with run_operation "item-receipts.action" and body { "action": "convert", "billNumber": "..." }. Naming the purchase order (purchase_order_id) marks those quantities received on it; every line\'s item must then be on that order with enough left to receive.',
    required: ['vendor_id', 'date', 'lines'],
    properties: {
      vendor_id: { ...ID, description: 'The vendor who delivered them (from list_vendors).' },
      date: { ...DATE, description: 'The day the items arrived.' },
      purchase_order_id: { ...ID, description: "The vendor's purchase order being received, if there is one (run_operation \"purchase-orders.list\")." },
      reference: TEXT(100, "The vendor's packing slip or reference number."),
      memo: TEXT(4000, 'Internal note.'),
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        description: 'The items received; at least one line.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item_id', 'quantity', 'unit_cost'],
          properties: {
            item_id: { ...ID, description: 'The item received (from list_items).' },
            description: TEXT(4000, 'Text saved on the line.'),
            quantity: { ...POSITIVE, description: 'Units received, as text ("10").' },
            unit_cost: { ...POSITIVE, description: 'Cost each, as text ("12.50").' },
            ...STOCK_FIELDS,
            lot_expiration: LOT_EXPIRATION,
          },
        },
      },
    },
    build: (a) => ({ operation: 'item-receipts.create', body: camelize(a) }),
  }),
  entryTool({
    name: 'enter_credit_memo',
    title: 'Enter a credit memo',
    operations: ['credit-memos.create'],
    confirm: ['allowDuplicateNumber'],
    description:
      'Enter a credit memo for a customer (a return, or money taken off what they owe). It posts to Accounts Receivable and income; returned inventory goes back in stock unless restock is false. The credit then waits to be used: apply it to an open invoice or refund it with run_operation "credit-memos.action" (body { "action": "apply", ... } or { "action": "refund", ... }; describe_operation shows the fields).',
    required: ['customer_id', 'date', 'lines'],
    properties: {
      customer_id: { ...ID, description: 'The customer credited (from list_customers).' },
      date: { ...DATE, description: 'Credit memo date.' },
      ref_number: TEXT(50, 'Credit memo number. Leave out for the next number.'),
      tax_rate_id: { ...TAX_RATE, description: "The sales tax item credited back on taxable lines. Leave out to use the customer's own; no_sales_tax true for none." },
      no_sales_tax: { ...NO_SALES_TAX, description: 'true: credit back no sales tax on this memo.' },
      memo: TEXT(4000, 'Internal note.'),
      class_id: { ...ID, description: 'Class for the whole memo, if used.' },
      job_id: { ...ID, description: "One of the customer's jobs, for job costing." },
      customer_message_id: CUSTOMER_MESSAGE,
      to_be_printed: TO_BE_PRINTED,
      to_be_emailed: TO_BE_EMAILED,
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        description: 'What is credited; at least one line.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['quantity'],
          properties: {
            item_id: { ...ID, description: 'The item credited or returned (from list_items).' },
            description: TEXT(4000, 'Text printed on the line.'),
            quantity: { ...QTY, description: 'Quantity credited or returned, as text.' },
            rate: { ...QTY, description: 'Price each, as text. Leave out on an item line to use the price Ironbooks works out.' },
            account_id: { ...ID, description: "The income account the credit reduces, instead of the item's own." },
            taxable: { type: 'boolean', description: 'Whether sales tax is credited back on the line (default true).' },
            sales_tax_code_id: { ...ID, description: 'A sales tax code ("Tax", "Non"). When given, it decides whether the line is taxable.' },
            restock: { type: 'boolean', description: 'Inventory items only: true (default) puts the units back in stock, false writes them off as damaged.' },
            class_id: { ...ID, description: "Class of the line (default: the memo's)." },
            job_id: { ...ID, description: "Job of the line (default: the memo's)." },
            ...STOCK_FIELDS,
          },
        },
      },
    },
    build: (a) => ({ operation: 'credit-memos.create', body: salesBody(a) }),
  }),
  entryTool({
    name: 'enter_vendor_credit',
    title: 'Enter a vendor credit',
    operations: ['vendor-credits.create'],
    description:
      'Enter a credit from a vendor (items returned, or money the vendor takes off what is owed). It posts to Accounts Payable and the accounts or items on its lines. Each line is an account with an amount, or an item returned with a quantity and a cost. Using the credit on a bill, or recording the vendor\'s refund, is run_operation "vendor-credits.action" (describe_operation shows the fields).',
    required: ['vendor_id', 'date', 'lines'],
    properties: {
      vendor_id: { ...ID, description: 'The vendor who gave the credit (from list_vendors).' },
      date: { ...DATE, description: 'Credit date.' },
      ref_number: TEXT(50, "The vendor's reference number for the credit."),
      memo: TEXT(4000, 'Internal note.'),
      currency: { type: 'string', pattern: '^[A-Z]{3}$', patternHint: 'must be a 3-letter currency code like EUR', description: "The vendor's currency (3 letters), only when it is not the home currency. It must match the vendor's." },
      exchange_rate: { ...POSITIVE, description: 'Home-currency units per 1 unit of that currency, as text ("1.10"). Leave out for the rate on the currency list.' },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        description: 'The credit lines; at least one. Each names an account (with amount) or an item (with quantity, and unit_cost or amount).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            account_id: { ...ID, description: 'The expense or asset account the credit reduces (from list_accounts).' },
            item_id: { ...ID, description: 'An item returned to the vendor (from list_items).' },
            quantity: { ...POSITIVE, description: 'Units returned, as text; needed on an item line.' },
            unit_cost: { ...MONEY, description: 'Cost each of the units returned.' },
            amount: { ...MONEY, description: 'The line amount; needed on an account line, and on an item line without unit_cost.' },
            description: TEXT(4000, 'Text saved on the line.'),
            class_id: { ...ID, description: 'Class, if used.' },
            customer_id: { ...ID, description: 'A customer this credit is for, for job costing.' },
            job_id: { ...ID, description: "One of that customer's jobs." },
            ...STOCK_FIELDS,
          },
        },
      },
    },
    build: (a) => ({ operation: 'vendor-credits.create', body: camelize(a) }),
  }),
  entryTool({
    name: 'enter_time',
    title: 'Enter time worked',
    operations: ['time-entries.create'],
    description:
      'Record hours worked by an employee (employee_id), optionally for a customer or job and as a service item, billable or not. It posts nothing to the ledger (the answer is "done"). Billable time is invoiced later: run_operation "time-entries.bill" with body { "customerId": "..." } puts all of a customer\'s unbilled time on one invoice. Paying the employee for it is payroll, not this.',
    required: ['date', 'hours'],
    properties: {
      date: { ...DATE, description: 'The day the work was done.' },
      hours: { ...POSITIVE, description: 'Hours worked, as text ("1.5").' },
      employee_id: { ...ID, description: 'Who did the work (from list_employees).' },
      customer_id: { ...ID, description: 'The customer the work was for (from list_customers).' },
      job_id: { ...ID, description: "One of that customer's jobs." },
      service_item_id: { ...ID, description: 'The service item the time is billed as (from list_items with type service).' },
      billable: { type: 'boolean', description: 'Whether it can be billed to the customer (default true).' },
      rate: { ...POSITIVE, description: "Hourly billing rate, as text (\"95.00\"). Leave out for the employee's billing rate or the service item's price." },
      description: TEXT(4000, 'What was done; it fills the invoice line when the time is billed.'),
    },
    build: (a) => ({ operation: 'time-entries.create', body: camelize(a) }),
  }),
  entryTool({
    name: 'adjust_inventory',
    title: 'Adjust inventory',
    operations: ['inventory.adjust', 'inventory.value-adjust'],
    description:
      'Adjust an inventory item. kind "quantity" (default): change the quantity on hand (quantity_change "5" adds, "-2" takes away), for shrinkage, damage or a recount; adding stock needs unit_cost. kind "value": set the item\'s total value or its cost each, without changing the quantity. Either posts to the inventory asset and the adjustment account (Inventory Adjustments unless you name one). A physical count of many items at once is run_operation "inventory.batch-count".',
    required: ['item_id', 'date'],
    properties: {
      kind: { type: 'string', enum: ['quantity', 'value'], description: 'quantity (default): change how many are on hand. value: change what they are worth.' },
      item_id: { ...ID, description: 'The inventory item (from list_items with type inventory).' },
      date: { ...DATE, description: 'Date of the adjustment.' },
      quantity_change: { ...QTY, description: 'quantity only: the change, as text: positive adds ("5"), negative takes away ("-2").' },
      unit_cost: { ...POSITIVE, description: 'quantity only: cost each of stock added; needed when adding.' },
      new_total_value: { ...MONEY, description: 'value only: what all units on hand are worth now. Give this or new_unit_cost.' },
      new_unit_cost: { ...POSITIVE, description: 'value only: what each unit on hand is worth now. Give this or new_total_value.' },
      memo: TEXT(1000, 'Why it is adjusted (saved with the adjustment).'),
      adjustment_account_id: { ...ID, description: 'The account for the other side (from list_accounts). Leave out for Inventory Adjustments.' },
      class_id: { ...ID, description: 'Class, if used.' },
      customer_id: { ...ID, description: 'A customer the adjustment is for, for job costing.' },
      job_id: { ...ID, description: "One of that customer's jobs." },
      ...STOCK_FIELDS,
      lot_expiration: LOT_EXPIRATION,
    },
    build: (a) => {
      const { kind = 'quantity', memo, ...rest } = a;
      const stock = ['site_id', 'bin_id', 'serial_numbers', 'lot_number', 'lot_expiration'];
      const given = (/** @type {string} */ k) => rest[k] !== undefined && rest[k] !== null;
      if (kind === 'value') {
        const wrong = ['quantity_change', 'unit_cost', ...stock].filter(given);
        if (wrong.length) throw new ToolError(`${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} only for kind "quantity". A value adjustment changes what the stock is worth, not where it is.`);
        if (given('new_total_value') === given('new_unit_cost')) throw new ToolError('For kind "value" give exactly one of new_total_value or new_unit_cost.');
        return { operation: 'inventory.value-adjust', body: camelize({ ...rest, reason: memo }) };
      }
      const wrong = ['new_total_value', 'new_unit_cost'].filter(given);
      if (wrong.length) throw new ToolError(`${wrong.join(' and ')} ${wrong.length === 1 ? 'is' : 'are'} only for kind "value".`);
      if (!given('quantity_change')) throw new ToolError('For kind "quantity" give quantity_change: positive adds stock, negative takes it away.');
      return { operation: 'inventory.adjust', body: camelize({ action: 'adjust', ...rest, memo }) };
    },
  }),
  entryTool({
    name: 'pay_sales_tax',
    title: 'Pay sales tax',
    operations: ['sales-tax.payments.create'],
    confirm: ['allowDuplicateNumber'],
    description:
      'Pay the sales tax owed to one or more tax agencies: one Sales Tax Payment check per agency, from one bank account. First see what is owed: run_operation with operation "sales-tax.due" (query { "dueThrough": "YYYY-MM-DD" } for an earlier period end) lists, under rows, each agency\'s id (agencyId: give it here as agency_id) and its amountDue. It posts to Sales Tax Payable and the bank account. The answer\'s total is the sum of the checks.',
    required: ['date', 'payment_account_id', 'payments'],
    properties: {
      date: { ...DATE, description: 'The check date.' },
      payment_account_id: { ...ID, description: 'The bank account it is paid from (from list_accounts).' },
      payments: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        description: 'Which agencies are paid, and how much each.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['agency_id', 'amount'],
          properties: {
            agency_id: { ...ID, description: 'The tax agency (from "sales-tax.due").' },
            amount: { ...MONEY, description: 'The amount paid to it.' },
          },
        },
      },
      due_through: { ...DATE, description: 'The end of the period being paid (as "sales-tax.due" showed it). Default: the end of the last filing period.' },
      memo: TEXT(1000, 'Memo on the checks. Leave out for the agency\'s account number memo.'),
      check_number: TEXT(50, 'The first check number. Leave out for the next number.'),
      to_print: { type: 'boolean', description: 'Put the checks in the print queue instead of numbering them now. Nothing is printed now.' },
    },
    build: (a) => ({ operation: 'sales-tax.payments.create', body: camelize(a) }),
  }),
];
