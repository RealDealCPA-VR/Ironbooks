/**
 * Agent full access: classification of the "sales" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/sales.test.ts.
 *
 * Read with the route handlers and the services they call. Notes that apply to many entries:
 *  - "Delete" on an invoice, sales receipt, payment or credit memo VOIDS it (the record stays,
 *    its ledger entry is reversed): 'change', not 'remove'. On a customer, job or sales rep it only
 *    makes the entry inactive, but nothing in the app makes it active again (a customer only
 *    through Undo of that last action), so those are 'remove', the same rule as vendors in
 *    purchases.ts. Estimates, sales orders, leads, customer prices and billing groups really are
 *    deleted ('remove').
 *  - Several POST routes on one record are action doors ({ action: 'convert' | 'void' | ... }).
 *    Each gets the class of its riskiest action, so no action slips under a lighter class.
 *  - amountField 'total' is the document total in the route's answer (the body has only lines).
 *    Voids carry one too, so two-person approval (D8) covers voiding a large document as it covers
 *    entering one: the void answers with the record, whose total (or a payment's amount) stays as it
 *    was; only balanceDue or unapplied is set to zero, and neither is used.
 *  - A bulk route that enters one invoice per customer or order lists each invoice's total in its
 *    answer, and a '*' path adds them up (created.*.total, results.*.total, assessed.*.charge), so
 *    two-person approval and a grant's maxAmount see the whole run. Each posts one ledger entry per
 *    invoice, and with an amountField the bridge compares the field only with the largest single
 *    entry, so the field must be the whole run's. The Income Tracker's 'convert' answers no totals
 *    and names no amountField, so after its dry run the bridge adds up every entry it posted.
 *  - Every GET here only reads. Two of them (GET /api/customers/bulk and GET /api/payments/discounts)
 *    reach ensureSeeded (lists/simpleLists.ts: the Terms and Sales Tax Code defaults), which saves
 *    nothing for a read-only context such as an agent's read; each says so in its "why".
 *  - Amounts, the same rule in every bucket: amountField names the money the route's ANSWER carries
 *    (lib/agent/facts.ts takes the larger of the body's and the answer's figure). A request with no
 *    amount counts as over every amount limit (policy.ts: the grant maxAmount check and
 *    needsTwoPerson) until its dry run. After it the bridge (lib/agent/bridge.ts factsFor) reads the
 *    run's whole ledger: the entries it posted, and the entries already in the books that it
 *    voided, deleted or changed in place (a void posts nothing new, but its entry counts at its
 *    total). With an amountField the amount is the larger of that field and the largest SINGLE one
 *    of those entries; with none it is all of them added up, and "0.00" only for a run that made
 *    new records and posted no entry (one that voided, deleted or changed a record already there
 *    and touched no entry stays unknown).
 *  - Confirmation flags: the sales receipt and payment body schemas carry allowReconciledEdit (and
 *    the payment one removeFromDeposit) because one schema serves the new record and the edit, but
 *    only the edit asks for them (updateSalesReceipt, updatePayment; a new record has no reconciled
 *    lines and is in no deposit yet), so they are listed on the PUT and PATCH entries alone.
 *  - `id` names an operation where the id rule (registry.ts operationIdFor) would give the neutral
 *    ".post" or a word that misleads, with a short verb: customers.bulk.save, invoices.post-draft.
 */
import type { ClassificationMap } from '../types';

/**
 * Flags an invoice save accepts after its 409 warnings (duplicate number, credit limit, over-billing).
 * Not checkStock: the NEGATIVE_STOCK warning is asked for with checkStock: true and answered by
 * resending checkStock: false (lib/services/stockWarning.ts), the opposite of an allow* flag, so it
 * cannot be listed here; without it the stock check does not run at all.
 */
const INVOICE_FLAGS: readonly string[] = ['allowDuplicateNumber', 'overrideCreditLimit', 'allowOverBilling'];

export const SALES_CLASSES: ClassificationMap = {
  // customers: the Customer Center list, one customer, and Add/Edit Multiple List Entries
  'GET /api/customers': { class: 'read', describe: 'List customers' },
  'POST /api/customers': {
    class: 'enter',
    describe: 'Add customer {displayName}',
    // An opening balance is recorded as an invoice to the customer.
    amountField: 'openingBalance',
  },
  'GET /api/customers/[id]': { class: 'read', describe: 'Show customer {id}' },
  'PATCH /api/customers/[id]': { class: 'change', describe: 'Edit customer {id}' },
  'DELETE /api/customers/[id]': {
    class: 'remove',
    describe: 'Make customer {id} inactive',
    why:
      'Only makes the customer inactive (its invoices and history stay), but the app has no "make active" for ' +
      'customers except Undo of that last action, so it is treated like a delete.',
  },
  'GET /api/customers/bulk': {
    class: 'read',
    describe: 'List customers as rows for Add/Edit Multiple',
    why: 'Read only because ensureSeeded (lib/services/lists/simpleLists.ts) returns early when ctx.readOnly is true: for a person the first read saves the default Terms and Sales Tax Code entries. The bridge must run it with ctx.readOnly set, not only a read-only database handle.',
  },
  'POST /api/customers/bulk': {
    class: 'bulk',
    id: 'customers.bulk.save',
    describe: 'Add or edit several customers at once',
    why: 'Add/Edit Multiple: one request saves every row (new customers, and edits of existing ones when a row has an id), all or nothing. Its preview option is dryRun: true in the body: every row is checked and the whole batch rolled back, so nothing is saved.',
    countField: 'rows',
    dryRun: 'preview',
    bodySchema: '@/lib/validation/lists#bulkSchema',
  },

  // jobs: the jobs of customers (Customer Center), with profitability
  'GET /api/jobs': { class: 'read', describe: 'List jobs' },
  'POST /api/jobs': { class: 'enter', describe: 'Add job {name}' },
  'GET /api/jobs/[id]': { class: 'read', describe: 'Show job {id}' },
  'PATCH /api/jobs/[id]': { class: 'change', describe: 'Edit job {id}' },
  'DELETE /api/jobs/[id]': {
    class: 'remove',
    describe: 'Make job {id} inactive',
    why: 'Only makes the job inactive (its history stays), but nothing in the app makes a job active again (not Edit, not Undo), so it is treated like a delete.',
  },

  // leads: the Lead Center, and turning a lead into a customer
  'GET /api/leads': { class: 'read', describe: 'List leads' },
  'POST /api/leads': { class: 'enter', describe: 'Add lead {name}' },
  'GET /api/leads/[id]': { class: 'read', describe: 'Show lead {id}' },
  'PATCH /api/leads/[id]': { class: 'change', describe: 'Edit lead {id}' },
  'DELETE /api/leads/[id]': { class: 'remove', describe: 'Delete lead {id} and its to-dos' },
  'POST /api/leads/[id]/convert': {
    class: 'change',
    describe: 'Turn lead {id} into a customer',
    why: 'Adds a customer, but also closes the lead for good: it is marked converted and inactive (it can then be neither deleted nor converted again) and its to-dos move to the new customer.',
  },

  // customer-prices: a customer's own price for an item
  'GET /api/customer-prices': { class: 'read', describe: 'List customer-specific prices' },
  'POST /api/customer-prices': {
    class: 'change',
    describe: 'Set the price of item {itemId} for customer {customerId} to {price} (replaces the price already set, if any)',
    why: 'Add or replace: when the customer already has a price for this item, it is changed (this is the only way to edit one); otherwise one is added.',
  },
  'DELETE /api/customer-prices/[id]': { class: 'remove', describe: 'Delete customer price {id}' },

  // invoices: entry, edit and void, drafts, email, PDFs, batch invoicing, retainage, statement charges
  'GET /api/invoices': { class: 'read', describe: 'List invoices' },
  'POST /api/invoices': {
    class: 'enter',
    describe: 'Enter an invoice to customer {customerId}',
    confirmFlags: [...INVOICE_FLAGS],
    amountField: 'total',
  },
  'GET /api/invoices/[id]': { class: 'read', describe: 'Show invoice {id}' },
  'PUT /api/invoices/[id]': {
    class: 'change',
    describe: 'Edit invoice {id}',
    confirmFlags: [...INVOICE_FLAGS],
    amountField: 'total',
  },
  'PATCH /api/invoices/[id]': {
    class: 'change',
    describe: 'Edit invoice {id}',
    confirmFlags: [...INVOICE_FLAGS],
    amountField: 'total',
  },
  'DELETE /api/invoices/[id]': {
    class: 'change',
    describe: 'Void invoice {id}',
    why: 'Voids the invoice (reverses its ledger entry); the record stays, marked void.',
    amountField: 'total',
  },
  'POST /api/invoices/[id]/email': {
    class: 'outside',
    describe: 'Email invoice {id} to {to}',
    why: 'Sends the invoice PDF by email (to the customer, or to the address given).',
    effects: ['email'],
  },
  'POST /api/invoices/[id]/post': {
    class: 'change',
    // The rule's "invoices.post" reads like the neutral ".post" every other bucket names away.
    id: 'invoices.post-draft',
    describe: 'Post draft invoice {id} to the books',
    why: 'Posts an existing draft (pending) invoice to the ledger; it creates no new record.',
    confirmFlags: ['overrideCreditLimit', 'allowOverBilling'],
    amountField: 'total',
  },
  'GET /api/invoices/[id]/pdf': { class: 'read', describe: 'Show invoice {id} as a PDF', output: 'pdf' },
  'GET /api/invoices/[id]/packing-slip': {
    class: 'read',
    describe: 'Show the packing slip for invoice {id}',
    output: 'pdf',
  },
  'POST /api/invoices/batch': {
    class: 'bulk',
    describe: 'Batch invoicing: bill the same lines to several customers',
    why:
      'One request enters one invoice per customer picked (up to 500). The amount is the sum of the ' +
      "invoices: each invoice's total is listed under created in the answer, and created.*.total adds them " +
      'up (a skipped customer has none).',
    countField: 'customerIds',
    confirmFlags: ['overrideCreditLimit'],
    amountField: 'created.*.total',
  },
  'GET /api/invoices/custom-fields': { class: 'read', describe: 'List the custom fields of invoices' },
  'GET /api/invoices/retainage': { class: 'read', describe: 'Show retainage held and billed by customer' },
  'POST /api/invoices/retainage': {
    class: 'enter',
    id: 'invoices.retainage.bill',
    describe: 'Bill released retainage to customer {customerId}',
    confirmFlags: ['allowDuplicateNumber', 'overrideCreditLimit'],
    // Not the body's 'amount': it is optional (left out, all the retainage still held is billed),
    // so the new invoice's total in the answer is the only figure that is always there.
    amountField: 'total',
  },
  'GET /api/invoices/statement-charges': { class: 'read', describe: 'List statement charges' },
  'POST /api/invoices/statement-charges': {
    class: 'enter',
    describe: 'Enter a statement charge for customer {customerId}',
    confirmFlags: ['overrideCreditLimit'],
    amountField: 'total',
  },
  'PUT /api/invoices/statement-charges/[id]': {
    class: 'change',
    describe: 'Edit statement charge {id}',
    confirmFlags: ['overrideCreditLimit'],
    amountField: 'total',
  },
  'PATCH /api/invoices/statement-charges/[id]': {
    class: 'change',
    describe: 'Edit statement charge {id}',
    confirmFlags: ['overrideCreditLimit'],
    amountField: 'total',
  },

  // estimates: entry and edit, convert or progress-bill to an invoice, void, delete, expire
  'GET /api/estimates': { class: 'read', describe: 'List estimates' },
  'POST /api/estimates': {
    class: 'enter',
    describe: 'Enter an estimate for customer {customerId}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'GET /api/estimates/[id]': { class: 'read', describe: 'Show estimate {id}' },
  'PATCH /api/estimates/[id]': {
    class: 'change',
    describe: 'Edit estimate {id} or change its status',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'POST /api/estimates/[id]': {
    class: 'change',
    describe: 'Make an invoice from estimate {id}, progress-bill it, or void it (action: {action})',
    why:
      "One door for 'convert' and 'progress' (a new invoice from the estimate) and 'void'; classed by its riskiest " +
      "action, voiding. 'convert' answers with the new invoice and 'void' with the estimate, both with a total; " +
      "'progress' answers { invoice, estimate, overBilled }, with no total at the top, so its amount counts as " +
      "over every amount limit until the dry run, whose one ledger entry (the new invoice's) then gives it.",
    confirmFlags: ['overrideCreditLimit', 'allowOverBilling'],
    amountField: 'total',
  },
  'DELETE /api/estimates/[id]': { class: 'remove', describe: 'Delete estimate {id}' },
  'GET /api/estimates/[id]/pdf': { class: 'read', describe: 'Show estimate {id} as a PDF', output: 'pdf' },
  'POST /api/estimates/expire': {
    class: 'bulk',
    describe: 'Reject every open or draft estimate that expires before {asOf} (default today)',
    why: 'One request changes every open or draft estimate whose expiration date is before asOf (default today). The body has no list: how many is known only from the dry run.',
  },

  // sales-orders: entry and edit, convert to an invoice, status, delete, backorders
  'GET /api/sales-orders': { class: 'read', describe: 'List sales orders' },
  'POST /api/sales-orders': {
    class: 'enter',
    describe: 'Enter a sales order for customer {customerId}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'GET /api/sales-orders/[id]': { class: 'read', describe: 'Show sales order {id}' },
  'PUT /api/sales-orders/[id]': {
    class: 'change',
    describe: 'Edit sales order {id}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'PATCH /api/sales-orders/[id]': {
    class: 'change',
    describe: 'Edit sales order {id}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'POST /api/sales-orders/[id]': {
    class: 'change',
    describe: 'Make an invoice from sales order {id}, or set its status (action: {action})',
    why:
      "One door for 'convert' (a new invoice from the order) and 'status' (close, reopen or void the order); " +
      "classed by its riskiest action, changing or voiding the order. 'convert' answers with the new invoice and " +
      "'status' with the order, both with a total.",
    confirmFlags: ['overrideCreditLimit'],
    amountField: 'total',
  },
  'DELETE /api/sales-orders/[id]': { class: 'remove', describe: 'Delete sales order {id}' },
  'GET /api/sales-orders/backorders': { class: 'read', describe: 'List sales order lines still on backorder' },

  // fulfillment: the Sales Order Fulfillment Worksheet, pick lists and packing slips
  'GET /api/fulfillment': { class: 'read', describe: 'Show the sales order fulfillment worksheet' },
  'POST /api/fulfillment': {
    class: 'bulk',
    id: 'fulfillment.invoice',
    describe: 'Invoice what can ship on the selected sales orders',
    why:
      'One request enters one invoice per sales order selected. The amount is the sum of the invoices: ' +
      "each invoice's total is listed under results in the answer (lib/services/fulfillment.ts " +
      'batchInvoiceSalesOrders), and results.*.total adds them up (an order that could not be invoiced has none).',
    countField: 'selections',
    amountField: 'results.*.total',
  },
  'GET /api/fulfillment/packing-slips': {
    class: 'read',
    describe: 'Show packing slips for the selected sales orders',
    output: 'pdf',
  },
  'GET /api/fulfillment/pick-list': {
    class: 'read',
    describe: 'Show a pick list for the selected sales orders',
    output: 'pdf',
  },

  // sales-receipts: entry, edit and void
  'GET /api/sales-receipts': { class: 'read', describe: 'List sales receipts' },
  'POST /api/sales-receipts': {
    class: 'enter',
    describe: 'Enter a sales receipt',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'GET /api/sales-receipts/[id]': { class: 'read', describe: 'Show sales receipt {id}' },
  'PUT /api/sales-receipts/[id]': {
    class: 'change',
    describe: 'Edit sales receipt {id}',
    confirmFlags: ['allowDuplicateNumber', 'allowReconciledEdit'],
    amountField: 'total',
  },
  'PATCH /api/sales-receipts/[id]': {
    class: 'change',
    describe: 'Edit sales receipt {id}',
    confirmFlags: ['allowDuplicateNumber', 'allowReconciledEdit'],
    amountField: 'total',
  },
  'DELETE /api/sales-receipts/[id]': {
    class: 'change',
    describe: 'Void sales receipt {id}',
    why: 'Voids the sales receipt (reverses its ledger entry and puts stock back); the record stays, marked void.',
    amountField: 'total',
  },

  // payments: Receive Payments, its credits, discounts and General Journal items
  'GET /api/payments': { class: 'read', describe: 'List payments received' },
  'POST /api/payments': {
    class: 'enter',
    describe: 'Receive a payment of {amount} from customer {customerId}',
    why:
      "The amount is the larger of the cash received and the credits applied, as for Pay Bills. The answer is { payment, entry, creditsApplied }: creditsApplied is one total of every credit the save used (credit memos, earlier payments, General Journal credits and offsets), and applying them posts no new entry, so amountField names it. The cash posts its own new entry, which the bridge takes when it is larger. " +
      'So a $1 payment that applies a $50,000 credit is judged at $50,000 by the two-person rule and a grant\'s maxAmount. A save that both receives cash and applies credits is judged by the larger of the two, not their sum. Until the dry run has answered, the amount is unknown and counts as over every amount limit.',
    amountField: 'creditsApplied',
  },
  'GET /api/payments/[id]': { class: 'read', describe: 'Show payment {id}' },
  'POST /api/payments/[id]': {
    class: 'change',
    describe: 'Apply, unapply or refund payment {id}, or record it as a bounced check (action: {action})',
    why: "One door for 'apply' and 'unapply' (applying credit to invoices), 'refund' (a refund paid from a bank account) and 'bounce' (Record Bounced Check). All of them change an existing payment and what it pays. 'amount' is in the body for 'refund' (and a partial 'unapply'); 'apply' (applications[].amountApplied) and 'bounce' (bankFee, customerFee) have none, and a missing amount counts as over every amount limit.",
    amountField: 'amount',
  },
  'PUT /api/payments/[id]': {
    class: 'change',
    describe: 'Edit payment {id}',
    // removeFromDeposit answers the "this payment is in a bank deposit" warning.
    confirmFlags: ['allowReconciledEdit', 'removeFromDeposit'],
    amountField: 'amount',
  },
  'PATCH /api/payments/[id]': {
    class: 'change',
    describe: 'Edit payment {id}',
    confirmFlags: ['allowReconciledEdit', 'removeFromDeposit'],
    amountField: 'amount',
  },
  'DELETE /api/payments/[id]': {
    class: 'change',
    describe: 'Void payment {id}',
    why: 'Voids the payment (reverses its ledger entry and reopens the invoices it paid); the record stays, marked void.',
    amountField: 'amount',
  },
  'GET /api/payments/credits': { class: 'read', describe: 'List the open credits of customer {customerId}' },
  'GET /api/payments/discounts': {
    class: 'read',
    describe: 'Suggest early-payment discounts for customer {customerId}',
    why: 'Read only because ensureSeeded (lib/services/lists/simpleLists.ts) returns early when ctx.readOnly is true: for a person the first terms lookup saves the default Terms entries. The bridge must run it with ctx.readOnly set, not only a read-only database handle.',
  },
  'GET /api/payments/journal-items': {
    class: 'read',
    describe: 'List General Journal charges and credits of customer {customerId}',
  },
  'POST /api/payments/journal-items': {
    class: 'change',
    id: 'payments.journal-items.apply',
    describe: "Apply or unapply a customer's General Journal credits and payments (action: {action})",
    why: "Applies (or unapplies) an existing General Journal credit or payment to invoices or General Journal charges. It creates no new transaction. 'amount' is in the body for 'apply_credit' only; 'apply_payment' (items[].amount) and 'unapply' have none, and a missing amount counts as over every amount limit.",
    amountField: 'amount',
  },

  // credit-memos: entry, edit and void; apply to an invoice, refund, unapply
  'GET /api/credit-memos': { class: 'read', describe: 'List credit memos' },
  'POST /api/credit-memos': {
    class: 'enter',
    describe: 'Enter a credit memo for customer {customerId}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'GET /api/credit-memos/[id]': { class: 'read', describe: 'Show credit memo {id}' },
  'POST /api/credit-memos/[id]': {
    class: 'change',
    describe: 'Apply credit memo {id} to an invoice, refund it, or unapply it (action: {action})',
    why: "One door for 'apply' and 'unapply' (applying the credit to an invoice) and 'refund' (paying the credit back from a bank account). All of them change what the existing credit memo is used for.",
    amountField: 'amount',
  },
  'PUT /api/credit-memos/[id]': {
    class: 'change',
    describe: 'Edit credit memo {id}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'PATCH /api/credit-memos/[id]': {
    class: 'change',
    describe: 'Edit credit memo {id}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'DELETE /api/credit-memos/[id]': {
    class: 'change',
    describe: 'Void credit memo {id}',
    why: 'Voids the credit memo (reverses its ledger entry); the record stays, marked void.',
    amountField: 'total',
  },

  // finance-charges: Assess Finance Charges and its preferences
  'POST /api/finance-charges': {
    class: 'bulk',
    describe: 'Assess finance charges as of {asOf}',
    why: 'One request enters one finance-charge invoice per customer with an overdue balance. customerIds narrows it; without it every customer in the preview is charged, so the count then comes from the dry run. A "settings" override in the body applies to this run only and only for someone who may change company preferences. The amount is the sum of the charges: each is listed under assessed in the answer, and assessed.*.charge adds them up.',
    countField: 'customerIds',
    amountField: 'assessed.*.charge',
  },
  'GET /api/finance-charges/preview': {
    class: 'read',
    describe: 'Preview the finance charges that would be assessed as of {asOf}',
  },
  'GET /api/finance-charges/settings': { class: 'read', describe: 'Show the finance charge preferences' },
  'PUT /api/finance-charges/settings': {
    class: 'settings',
    describe: 'Change the finance charge preferences',
    why: 'Company preferences (rate, minimum, grace days, account), stored in the company settings.',
  },
  'PATCH /api/finance-charges/settings': {
    class: 'settings',
    describe: 'Change the finance charge preferences',
    why: 'Company preferences (rate, minimum, grace days, account), stored in the company settings.',
  },

  // billables: unbilled time and costs of a customer
  'GET /api/billables': { class: 'read', describe: 'List unbilled time and costs of customer {customerId}' },

  // billing-groups: the Billing Group list used by batch invoicing
  'GET /api/billing-groups': { class: 'read', describe: 'List billing groups' },
  'POST /api/billing-groups': { class: 'enter', describe: 'Add billing group {name}' },
  'GET /api/billing-groups/[id]': { class: 'read', describe: 'Show billing group {id}' },
  'PATCH /api/billing-groups/[id]': { class: 'change', describe: 'Edit billing group {id} or its customers' },
  'DELETE /api/billing-groups/[id]': {
    class: 'remove',
    describe: 'Delete billing group {id} (its customers stay)',
  },

  // income-tracker: the Income Tracker and its batch actions
  'GET /api/income-tracker': { class: 'read', describe: 'Show the Income Tracker' },
  'POST /api/income-tracker/actions': {
    class: 'outside',
    describe: 'Email, queue or convert the selected Income Tracker rows (action: {action})',
    why: "One door for 'email' (emails each selected form), 'queue_print' and 'queue_email' (marks forms to send later) and 'convert' (one invoice per estimate, sales order or customer's unbilled time). Classed by its riskiest action, the email. No amountField: 'convert' answers with done and failed lists and no totals, so nothing can add them up. It posts one ledger entry per invoice, and after the dry run the bridge adds up every entry posted, so the two-person rule and a grant's maxAmount see the whole run, not its largest invoice; the bulk cap limits how many.",
    effects: ['email'],
    countField: 'items',
    confirmFlags: ['overrideCreditLimit'],
  },

  // collections: the Collections Center, contact notes, reminder emails and letters
  'GET /api/collections': { class: 'read', describe: 'Show the Collections Center' },
  'POST /api/collections/contacts': {
    class: 'prepare',
    describe: 'Record a collection contact with customer {customerId}',
    why: 'Saves a collection note, and optionally a to-do and a customer note. Nothing reaches the books.',
  },
  'POST /api/collections/email': {
    class: 'outside',
    describe: 'Email customer {customerId} a collection reminder with their overdue {what} (to {to} when given)',
    why: 'Emails the overdue invoices or a statement, then records the contact.',
    effects: ['email'],
  },
  'POST /api/collections/letter': {
    class: 'prepare',
    describe: 'Make a collection letter for customer {customerId}',
    why: 'Makes the letter PDF and saves a collection note (and optionally a to-do). Nothing reaches the books and nothing is printed or sent.',
    output: 'pdf',
  },
  'GET /api/collections/notes': { class: 'read', describe: 'List collection notes of customer {customerId}' },
  'POST /api/collections/notes': {
    class: 'prepare',
    describe: 'Add a collection note for customer {customerId}',
    why: 'A note with an optional follow-up date. Nothing reaches the books.',
  },
  'PATCH /api/collections/notes/[id]': {
    class: 'prepare',
    describe: 'Mark the follow-up of collection note {id} done (or not done again when done is false)',
    why: 'Ticks or unticks a follow-up on a note. Nothing reaches the books.',
  },

  // sales-forms: PDFs of any A/R form, send flags, Print Forms / Send Forms, statements by email
  'GET /api/sales-forms/[kind]/[id]/pdf': { class: 'read', describe: 'Show {kind} {id} as a PDF', output: 'pdf' },
  'POST /api/sales-forms/[kind]/[id]/email': {
    class: 'outside',
    describe: 'Email {kind} {id} to {to}',
    why: 'Sends the form PDF by email (to the customer, or to the address given).',
    effects: ['email'],
  },
  'PATCH /api/sales-forms/[kind]/[id]/flags': {
    class: 'change',
    describe: 'Set the "to be printed" or "to be emailed" mark of {kind} {id}',
  },
  'GET /api/sales-forms/queue': { class: 'read', describe: 'List the forms waiting to be printed or emailed' },
  'POST /api/sales-forms/queue': {
    class: 'outside',
    id: 'sales-forms.queue.run',
    describe: 'Email the selected forms, or mark them printed (Print Forms / Send Forms, action: {action})',
    why: "One door for 'send_emails' (emails every selected form) and 'mark_printed' (clears their \"to be printed\" mark). Classed by its riskiest action, the email.",
    effects: ['email'],
    countField: 'items',
  },
  'POST /api/sales-forms/statement-email': {
    class: 'outside',
    describe: 'Email a statement to customer {customerId} (to {email} when given)',
    why: 'Sends the statement PDF by email (to the customer, or to the address given).',
    effects: ['email'],
  },

  // job-type-assign: a job's Job Type
  'POST /api/job-type-assign': {
    class: 'change',
    describe: 'Set the job type of job {jobId}',
    why: 'Changes a field of an existing job; it creates nothing.',
  },

  // sales-reps: the Sales Rep list, and the rep on an invoice
  'GET /api/sales-reps': { class: 'read', describe: 'List sales reps' },
  'POST /api/sales-reps': { class: 'enter', describe: 'Add sales rep {name}' },
  'GET /api/sales-reps/[id]': { class: 'read', describe: 'Show sales rep {id}' },
  'PATCH /api/sales-reps/[id]': { class: 'change', describe: 'Edit sales rep {id}' },
  'DELETE /api/sales-reps/[id]': {
    class: 'remove',
    describe: 'Make sales rep {id} inactive',
    why: 'Only makes the sales rep inactive (its history stays), but nothing in the app makes a rep active again (Edit takes only name, email and rate; there is no Undo), and an inactive rep can no longer be put on an invoice, so it is treated like a delete.',
  },
  'POST /api/sales-reps/assign': {
    class: 'change',
    describe: 'Set the sales rep of invoice {invoiceId}',
    why: 'Changes a field of an existing invoice; it creates nothing.',
  },
};
