/**
 * Agent full access: classification of the "planning" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/planning.test.ts.
 *
 * Sales tax items are 'settings' while payroll items stay 'change' with alwaysAsk (payroll.ts): a
 * sales tax item's rate is what every later sale charges, while a payroll item's rate is not what
 * paychecks use (the tax tables and state settings are, and those are 'settings' too). What a
 * payroll item does steer (tax tracking, pre-tax treatment, posting accounts) is asked every time.
 *
 * `id` names an operation where the id rule (registry.ts operationIdFor) would give the neutral
 * ".post" or a word that misleads: GET /api/sales-tax/pay only shows what is due (sales-tax.due),
 * its POST writes the Sales Tax Payment checks (sales-tax.payments.create, beside the list of those
 * checks, sales-tax.payments). The POST never takes "sales-tax.pay": that was the GET's id before,
 * and an id that once named a read must never come to name a payment (a stored request or grant
 * under the old id would then point at the payment).
 */
import type { ClassificationMap } from '../types';

export const PLANNING_CLASSES: ClassificationMap = {
  // Sales tax agencies: who the tax is paid to. Adding one is sales tax setup (plan section 8).
  'GET /api/tax-agencies': { class: 'read', id: 'tax-agencies.list', describe: 'List sales tax agencies' },
  'POST /api/tax-agencies': {
    class: 'settings',
    id: 'tax-agencies.create',
    describe: 'Add sales tax agency {name}',
    why: 'Sales tax setup: the agency is what sales tax items report to and what Pay Sales Tax pays (plan section 8 puts agencies under settings).',
  },

  // Sales tax items (rates) and the parts of a combined rate: sales tax setup.
  'GET /api/tax-rates': { class: 'read', describe: 'List sales tax items' },
  'POST /api/tax-rates': {
    class: 'settings',
    describe: 'Add sales tax item {name} at rate {rate}',
    why: 'Sales tax setup: the rate new invoices, sales receipts and credit memos charge when they use this item.',
  },
  'PATCH /api/tax-rates/[id]': {
    class: 'settings',
    describe: 'Change sales tax item {id}',
    why: 'Sales tax setup: a new rate or agency applies to every transaction entered from now on, and making the item inactive takes it off the forms.',
  },
  'GET /api/tax-rates/[id]/components': { class: 'read', describe: 'List the component rates of sales tax item {id}' },
  'PATCH /api/tax-rates/[id]/components': {
    class: 'settings',
    describe: 'Replace the component rates of sales tax item {id}',
    why: 'Sales tax setup: replaces every component and works the combined rate out again, which new transactions then charge.',
  },

  // Pay Sales Tax and the Sales Tax Payment checks it writes.
  'GET /api/sales-tax/pay': { class: 'read', id: 'sales-tax.due', describe: 'Show the sales tax due to each agency' },
  // A Sales Tax Payment check stores the memo "Acct # <the agency vendor's full account number>"
  // when none is typed: the check prints it, and the agency applies the payment by it. Every check
  // answer masks it for a caller without "view full account numbers" (liabilityPayments.ts
  // checkMemoFor), and the payment's journal line no longer carries it. So these keep their class
  // and carry `reveal`: an unmasked memo is a separate, approved request. sensitiveFields still keeps
  // the memo out of previews, stored requests and logs.
  'POST /api/sales-tax/pay': {
    class: 'enter',
    id: 'sales-tax.payments.create',
    describe: 'Pay {total} of sales tax to the agencies picked, from account {paymentAccountId} on {date}',
    why: 'Writes one Sales Tax Payment check per agency picked, in one transaction, and adds and links a vendor for an agency that has none yet. Kept as entry, not bulk: it is one payment run on one screen (plan section 8: enter (pay)). The amount is the answer\'s total (the sum of payments[].amount), so until the preview has run it counts as over any limit. The checks in the answer have their memo masked.',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
    reveal: 'account_numbers',
    sensitiveFields: ['checks.*.memo'],
  },
  'GET /api/sales-tax/payments': {
    class: 'read',
    describe: 'List sales tax payment checks',
    reveal: 'account_numbers',
    sensitiveFields: ['items.*.memo'],
  },
  'GET /api/sales-tax/payments/[id]': {
    class: 'read',
    describe: 'Show sales tax payment check {id}',
    reveal: 'account_numbers',
    sensitiveFields: ['memo'],
  },
  'POST /api/sales-tax/payments/[id]': {
    class: 'change',
    describe: 'Void sales tax payment check {id}',
    why: 'Voiding is the only thing this POST does: the check stays, marked void, the tax is owed again and the bank gets the money back. The answer is the voided check, its amount as it was and its memo masked.',
    amountField: 'amount',
    reveal: 'account_numbers',
    sensitiveFields: ['memo'],
  },

  // Budgets and forecasts: planning amounts, never posted to the ledger.
  'GET /api/budgets': { class: 'read', describe: 'List budgets and forecasts' },
  'POST /api/budgets': { class: 'enter', describe: 'Create budget {name} for fiscal year {fiscalYear}' },
  'GET /api/budgets/[id]': { class: 'read', describe: 'Show budget {id} with its amounts' },
  'PATCH /api/budgets/[id]': {
    class: 'change',
    describe: 'Set the amount of budget {id} for account {accountId} in month {month} to {amount}',
  },
  'GET /api/budgets/[id]/vs-actual': { class: 'read', describe: 'Compare budget {id} with the actual amounts' },
  'POST /api/budgets/[id]/adjust': {
    class: 'bulk',
    describe: 'Change the amounts of budget {id} by {percent} percent',
    why: 'One request changes every matching amount of the budget (every one when no accounts are named), so no body array gives the count; the answer\'s "lines" says how many changed.',
  },
  'POST /api/budgets/[id]/copy': {
    class: 'enter',
    describe: 'Copy budget {id} into new budget {name} for fiscal year {fiscalYear}',
  },
  'POST /api/budgets/[id]/fill-from-actuals': {
    class: 'bulk',
    describe: 'Fill budget {id} with actual amounts',
    why: 'One request replaces every amount of the budget (or of one class or Customer:Job in it) with a year\'s actuals, and the old amounts are gone. No body array gives the count; the answer\'s "lines" says how many were written.',
  },

  // Time entries (Time Tracking), and billing a customer's unbilled time.
  'GET /api/time-entries': { class: 'read', describe: 'List time entries' },
  'POST /api/time-entries': { class: 'enter', describe: 'Enter {hours} hours of time on {date}' },
  'PATCH /api/time-entries/[id]': { class: 'change', describe: 'Change time entry {id}' },
  'DELETE /api/time-entries/[id]': { class: 'remove', describe: 'Delete time entry {id}' },
  'POST /api/time-entries/bill': {
    class: 'enter',
    describe: 'Invoice customer {customerId} for their unbilled time',
    why: 'Enters one new invoice, dated today, for all of the customer\'s unbilled billable time and marks that time billed. One invoice, so entry rather than bulk.',
    amountField: 'total',
  },

  // Mileage log.
  'GET /api/mileage': { class: 'read', describe: 'List mileage trips or the mileage summary' },
  'POST /api/mileage': { class: 'enter', describe: 'Log a mileage trip ({miles} miles)' },
  'DELETE /api/mileage/[id]': { class: 'remove', describe: 'Delete mileage trip {id}' },

  // Fixed assets and their monthly depreciation.
  'GET /api/fixed-assets': { class: 'read', describe: 'List fixed assets' },
  'POST /api/fixed-assets': { class: 'enter', describe: 'Add fixed asset {name} costing {cost}', amountField: 'cost' },
  'GET /api/fixed-assets/[id]': { class: 'read', describe: 'Show fixed asset {id} with its depreciation schedule' },
  'POST /api/fixed-assets/[id]': {
    class: 'enter',
    describe: 'Post depreciation for fixed asset {id} on {date}',
    why: 'Posts one month of depreciation for this one asset as a new journal entry (refused when that month is already posted), so it is entry, not a depreciation run across assets. The first post may also add the Depreciation Expense and Accumulated Depreciation accounts.',
    amountField: 'periodAmount',
  },

  // Loan Manager: loans, their payments and What If scenarios.
  'GET /api/loans': { class: 'read', describe: 'List loans in the Loan Manager' },
  'POST /api/loans': { class: 'enter', describe: 'Add loan {name} for {originalAmount}', amountField: 'originalAmount' },
  'POST /api/loans/what-if': {
    class: 'read',
    describe: 'Work out the payment and interest of a possible loan of {originalAmount}',
    why: 'Only computes a schedule from the numbers sent. Nothing is saved and the books are not read.',
  },
  'GET /api/loans/[id]': { class: 'read', describe: 'Show loan {id} with its payments and schedule' },
  'PATCH /api/loans/[id]': { class: 'change', describe: 'Change the terms of loan {id}' },
  'DELETE /api/loans/[id]': {
    class: 'remove',
    describe: 'Remove loan {id} from the Loan Manager',
    why: 'Takes the loan off the Loan Manager. Its checks and bills stay on the books, but no screen or route puts the loan back.',
  },
  'POST /api/loans/[id]/payments': {
    class: 'enter',
    describe: 'Write the next payment of loan {id} as a {kind}',
    amountField: 'total',
  },
  'DELETE /api/loans/[id]/payments': {
    class: 'change',
    describe: 'Void a payment of loan {id} (payment {paymentId})',
    why: 'Voids the payment\'s check or bill (and its exchange gain or loss entry) rather than deleting it: the records stay on the books, marked void. The amount is the answer\'s total (the loan payment voided).',
    amountField: 'total',
  },
  'POST /api/loans/[id]/what-if': {
    class: 'read',
    describe: 'Work out a What If scenario for loan {id}',
    why: 'Only reads the loan and computes its schedule with the changes sent. Nothing is saved.',
  },

  // Reminders list.
  'GET /api/reminders': { class: 'read', describe: 'Show the Reminders list' },

  // "Needs attention" inbox: reads, plus its Back up now and payment reminder buttons.
  'GET /api/attention': {
    class: 'read',
    describe: 'Show the Needs attention inbox',
    why: 'Reads only, for an agent. The service also forgets a person\'s snoozes of items that no longer exist, but only for a signed-in person (an agent\'s context has no person), and a failure there is ignored. The backup item, which can record the backup folder list on disk, is only built for a file Admin person, never for an agent.',
  },
  'GET /api/attention/count': {
    class: 'read',
    describe: 'Count the items that need attention',
    why: 'Reads only, for an agent: the same inbox as GET /api/attention, whose snooze housekeeping runs only for a signed-in person.',
  },
  'POST /api/attention/state': {
    class: 'prepare',
    availability: 'person_only',
    describe: 'Snooze, dismiss or bring back inbox item {key}',
    why: 'Snoozes and dismissals belong to the signed-in person (their own view of the inbox, like My Preferences). An agent has no inbox of its own, and the service refuses a call with no person.',
  },
  'POST /api/attention/invoice-reminder': {
    class: 'outside',
    describe: 'Email a payment reminder for invoice {invoiceId} to {to}',
    why: 'Emails the customer a reminder with the invoice PDF attached. Nothing in the books changes.',
    effects: ['email'],
  },
  'POST /api/attention/backup': {
    class: 'file',
    describe: 'Back up the company file now',
    why: 'Writes a full backup of the company file into the backup folder (which may be a network share) and rotates older versioned backups, deleting the oldest past the number kept. The backup service opens its own database handle, so it cannot be previewed in a rolled-back transaction.',
    fileAdmin: true,
    dryRun: 'none',
    body: 'none',
    effects: ['file'],
  },
};
