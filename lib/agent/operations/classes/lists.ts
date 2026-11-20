/**
 * Agent full access: classification of the "lists" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/lists.test.ts.
 */
import type { ClassificationMap } from '../types';

export const LISTS_CLASSES: ClassificationMap = {
  // Company > System Accounts: which account Ironbooks posts to on its own, by role.
  'GET /api/account-roles': { class: 'read', describe: 'List the system accounts Ironbooks posts to on its own' },
  'PATCH /api/account-roles': {
    class: 'settings',
    describe: 'Set the {role} system account to account {accountId} (empty puts back the one Ironbooks picks on its own)',
    why: 'A company preference (Company & Preferences: modify, checked by the service): every invoice, bill, payment or paycheck entered afterwards posts to the account chosen here.',
  },

  // Chart of accounts. GETs hide balances from roles without View Balance (balancesForContext).
  'GET /api/accounts': { class: 'read', describe: 'List the chart of accounts' },
  'POST /api/accounts': {
    class: 'enter',
    describe: 'Add account {name} with opening balance {openingBalance} as of {openingBalanceDate}',
    why: 'Kept as entry: a new list entry, and an opening balance posts one opening-balance entry to the books like any other new transaction.',
    amountField: 'openingBalance',
  },
  'GET /api/accounts/[id]': { class: 'read', describe: 'Show account {id}' },
  'PATCH /api/accounts/[id]': { class: 'change', describe: 'Change account {id}' },
  'DELETE /api/accounts/[id]': {
    class: 'remove',
    describe: 'Make account {id} inactive, or delete it for good when permanent is 1 (permanent: {permanent})',
    why: 'Without ?permanent=1 it only makes the account inactive, but with it a never-used account is deleted for good. One class covers both, so it is the stronger one.',
  },
  'GET /api/accounts/tax-lines': { class: 'read', describe: 'Show the income tax form and the tax line of each account' },
  'PUT /api/accounts/tax-lines': {
    class: 'settings',
    describe: 'Set the company income tax form to {form}',
    why: 'Income tax setup: the form is a company setting the income tax reports are built from.',
  },

  // Classes and locations. The PATCH only makes the entry inactive; it reads no body.
  'GET /api/classes': { class: 'read', describe: 'List classes' },
  'POST /api/classes': { class: 'enter', describe: 'Add class {name}' },
  'PATCH /api/classes/[id]': { class: 'change', describe: 'Make class {id} inactive', body: 'none' },
  'GET /api/locations': { class: 'read', describe: 'List locations' },
  'POST /api/locations': { class: 'enter', describe: 'Add location {name}' },
  'PATCH /api/locations/[id]': { class: 'change', describe: 'Make location {id} inactive', body: 'none' },

  // Simple lists (other names, job types, terms, ship via, payment methods, customer messages,
  // sales tax codes, vehicles). The body schema depends on {list}, so none is named here. Other
  // Names carry an account number, masked unless the caller may view full account numbers.
  'GET /api/lists/[list]': {
    class: 'read',
    describe: 'List the entries of the {list} list',
    why: 'Read only because ensureSeeded (lib/services/lists/simpleLists.ts) returns early when ctx.readOnly is true: for a person the first read of a list saves its default entries. The bridge must run it with ctx.readOnly set, not only a read-only database handle, or the first read on a new company either writes those entries or is refused.',
    reveal: 'account_numbers',
    sensitiveFields: ['entries.*.accountNumber'],
  },
  'POST /api/lists/[list]': {
    class: 'enter',
    describe: 'Add {name} to the {list} list',
    sensitiveFields: ['accountNumber'],
  },
  'PATCH /api/lists/[list]/[id]': {
    class: 'settings',
    describe: 'Change entry {id} of the {list} list',
    why: 'Set by the sales tax codes list, the only place tax codes are edited: it is sales tax setup (the service asks for the sales tax codes right, like PATCH /api/tax-rates/[id]), and a code made taxable or non-taxable re-flags every item and customer using it in the same request, which decides the tax on every sale entered afterwards. One class covers every list, so it is the stronger one; an edit of an ordinary entry (ship via, terms ...) would be "change". A renamed terms entry also renames the terms text on its vendors and customers.',
    sensitiveFields: ['accountNumber'],
  },
  'DELETE /api/lists/[list]/[id]': {
    class: 'remove',
    describe: 'Delete entry {id} of the {list} list (made inactive when in use)',
  },

  // Customer Type and Vendor Type lists, and setting a vendor's type.
  'GET /api/type-lists/[kind]': { class: 'read', describe: 'List {kind} types' },
  'POST /api/type-lists/[kind]': { class: 'enter', describe: 'Add {kind} type {name}' },
  'PUT /api/type-lists/[kind]/[id]': { class: 'change', describe: 'Change {kind} type {id}' },
  'DELETE /api/type-lists/[kind]/[id]': {
    class: 'remove',
    describe: 'Delete {kind} type {id} (made inactive when in use)',
  },
  'POST /api/type-lists/vendor-assign': {
    class: 'change',
    describe: 'Set the vendor type of vendor {vendorId} to {vendorTypeId}',
    why: 'Edits an existing vendor record (its type); nothing new is entered. Known leak: the answer is the whole vendor row and assignVendorType (lib/services/typeLists.ts) does not pass it through maskForContext, so the full tax ID (a sole proprietor\'s SSN) and the full account number come back to any caller. sensitiveFields only covers previews, stored requests and logs; until the service masks its answer, the bridge must mask it (maskForContext) before an agent sees it.',
    sensitiveFields: ['taxId', 'accountNumber'],
  },

  // Custom fields: the field definitions are a company setting; the values live on each record.
  'GET /api/custom-fields': { class: 'read', describe: 'List the custom field definitions' },
  'PATCH /api/custom-fields': {
    class: 'settings',
    describe: 'Replace the custom field definitions',
    why: 'Defines which extra fields every customer, vendor, item and invoice form shows. Stored in the company settings (audited as a company change), and a list sent replaces the whole list for that kind of record.',
  },
  'POST /api/custom-fields/values': {
    class: 'change',
    describe: 'Set custom field values on {entity} {id}',
    why: 'Edits the custom field values of an existing customer, vendor, item or invoice; nothing new is entered.',
  },

  // Currencies and exchange rates; FX gain/loss entries and Home Currency Adjustments.
  'GET /api/currencies': { class: 'read', describe: 'List currencies and their exchange rates' },
  'POST /api/currencies': {
    class: 'settings',
    describe: 'Add or update currency {code} at rate {rateToBase} (make it the home currency: {isBase})',
    why: 'Exchange-rate setup: the rate is the default every new document in that currency books at. isBase: true changes the home currency instead: every other rate is rebased onto it, and when the old home currency is the only other one listed it is taken off the list. Like sales tax rates, this is setup, not entry.',
  },
  'POST /api/currencies/fx-adjustment': {
    class: 'enter',
    describe: 'Record an exchange gain or loss of {amount} on account {accountId} dated {date}',
    amountField: 'amount',
  },
  'GET /api/currencies/home-currency-adjustment': { class: 'read', describe: 'List home currency adjustments' },
  'POST /api/currencies/home-currency-adjustment': {
    class: 'settings',
    describe: 'Post a home currency adjustment dated {date} at rates {rates}',
    why: 'Exchange-rate setup as well as an entry: unless updateCurrencyList is false it saves the rates sent to the currency list, the default every new foreign-currency document books at (what POST /api/currencies does, also "settings"). In the same request it posts one adjusting entry that permanently revalues every foreign-currency bank and card account at those rates (plus a next-day reversal for A/R, A/P and loans), and voids the exchange gain or loss entries of loan payments that were voided elsewhere. preview: true only computes it.',
    dryRun: 'preview',
  },
  'GET /api/currencies/home-currency-adjustment/[id]': { class: 'read', describe: 'Show home currency adjustment {id}' },
  'DELETE /api/currencies/home-currency-adjustment/[id]': {
    class: 'change',
    describe: 'Void home currency adjustment {id} and its reversal',
    why: 'Voids, not deletes: the adjustment and both its entries stay, marked void.',
  },

  // Dated notes on customers, vendors, employees and other names: never reach the ledger.
  'GET /api/notes': { class: 'read', describe: 'List the notes on {entityType} {entityId}' },
  'POST /api/notes': {
    class: 'prepare',
    describe: 'Add a note to {entityType} {entityId}',
    why: 'A note on a record never reaches the books, and a person can delete it.',
    bodySchema: '@/lib/validation/lists#noteSchema',
  },
  'PATCH /api/notes/[id]': {
    class: 'prepare',
    describe: 'Change note {id}',
    why: 'A note on a record never reaches the books.',
    bodySchema: '@/lib/validation/lists#noteUpdateSchema',
  },
  'DELETE /api/notes/[id]': { class: 'remove', describe: 'Delete note {id}' },

  // The To Do list. /api/calendar/todos is the same store under an older path. No bodySchema:
  // the handlers parse with parseTodoBody (lib/services/todos.ts), which takes more than the old
  // todoSchema (due time, reminder, done, a link to a lead).
  'GET /api/todos': { class: 'read', describe: 'List to-dos' },
  'POST /api/todos': {
    class: 'prepare',
    describe: 'Add to-do {title}',
    why: 'A to-do never reaches the books, and a person can delete it.',
  },
  'GET /api/todos/[id]': { class: 'read', describe: 'Show to-do {id}' },
  'PATCH /api/todos/[id]': {
    class: 'prepare',
    describe: 'Change to-do {id}',
    why: 'Editing a to-do or marking it done never reaches the books.',
  },
  'DELETE /api/todos/[id]': { class: 'remove', describe: 'Delete to-do {id}' },

  // Calendar, and its older to-do paths.
  'GET /api/calendar': { class: 'read', describe: 'Show the calendar from {from} to {to}' },
  'GET /api/calendar/todos': { class: 'read', describe: 'List to-dos' },
  'POST /api/calendar/todos': {
    class: 'prepare',
    describe: 'Add to-do {title}',
    why: 'A to-do never reaches the books, and a person can delete it.',
  },
  'PATCH /api/calendar/todos/[id]': {
    class: 'prepare',
    describe: 'Change to-do {id}',
    why: 'Editing a to-do or marking it done never reaches the books.',
  },
  'DELETE /api/calendar/todos/[id]': { class: 'remove', describe: 'Delete to-do {id}' },

  // Billing rate levels: the hourly rate billed for a person's time.
  'GET /api/billing-rate-levels': { class: 'read', describe: 'List billing rate levels' },
  'POST /api/billing-rate-levels': {
    class: 'enter',
    describe: 'Add billing rate level {name}',
    bodySchema: '@/lib/validation/lists#billingRateLevelSchema',
  },
  'GET /api/billing-rate-levels/[id]': { class: 'read', describe: 'Show billing rate level {id}' },
  'PUT /api/billing-rate-levels/[id]': {
    class: 'change',
    describe: 'Replace billing rate level {id}',
    bodySchema: '@/lib/validation/lists#billingRateLevelSchema',
  },
  'DELETE /api/billing-rate-levels/[id]': {
    class: 'remove',
    describe: 'Delete billing rate level {id} (made inactive when in use)',
  },
  'POST /api/billing-rate-levels/assign': {
    class: 'change',
    describe: 'Set billing rate level {levelId} on employee {employeeId} / vendor {vendorId} / other name {otherNameId} (empty level clears it)',
    why: 'Edits an existing employee, vendor or other name record (its billing rate level); nothing new is entered.',
  },
  'GET /api/billing-rate-levels/resolve': { class: 'read', describe: 'Look up the hourly rate billed for item {itemId}' },

  // Unit of measure sets.
  'GET /api/uom-sets': { class: 'read', describe: 'List unit of measure sets' },
  'POST /api/uom-sets': {
    class: 'enter',
    describe: 'Add unit of measure set {name}',
    bodySchema: '@/lib/validation/lists#uomSetSchema',
  },
  'GET /api/uom-sets/[id]': { class: 'read', describe: 'Show unit of measure set {id}' },
  'PUT /api/uom-sets/[id]': {
    class: 'change',
    describe: 'Replace unit of measure set {id}',
    bodySchema: '@/lib/validation/lists#uomSetSchema',
  },
  'DELETE /api/uom-sets/[id]': {
    class: 'remove',
    describe: 'Delete unit of measure set {id} (made inactive when in use)',
  },

  // Merge Entries and Clean Up Company Data: list entries go away for good.
  'POST /api/merge': {
    class: 'remove',
    describe: 'Merge {type} {fromId} into {toId}',
    why: 'Every transaction of the merged entry moves to the one kept and the merged entry is retired. There is no unmerge, so it is treated as a delete (plan section 8: merge is remove-like). It rewrites posted history: journal lines are re-pointed on every date under allowLedgerRewrite(\'merge\'), closed periods included, with no closing-date check.',
  },
  'GET /api/cleanup': { class: 'read', describe: 'Preview the unused inactive list entries Clean Up would delete' },
  'POST /api/cleanup': {
    class: 'remove',
    describe: 'Delete unused inactive list entries',
    why: 'Deletes many list entries for good in one request. ids limits it to entries picked from the preview (GET /api/cleanup); without ids every eligible entry of the named lists (all lists when none are named) is deleted.',
    countField: 'ids',
  },

  // Items.
  'GET /api/items': { class: 'read', describe: 'List items' },
  'POST /api/items': {
    class: 'enter',
    describe: 'Add item {name} with opening quantity {openingQuantity} and opening value {openingValue}',
    why: 'Kept as entry: a new list entry, and an opening quantity posts the opening stock to the books like any other new transaction.',
  },
  'GET /api/items/[id]': { class: 'read', describe: 'Show item {id}' },
  'PATCH /api/items/[id]': { class: 'change', describe: 'Change item {id}' },
  'DELETE /api/items/[id]': {
    class: 'change',
    describe: 'Make item {id} inactive',
    why: 'Only makes the item inactive (deactivateItem); nothing is deleted and it can be made active again.',
  },
  'GET /api/items/[id]/components': { class: 'read', describe: 'List the components of bundle item {id}' },
  'GET /api/items/barcode': { class: 'read', describe: 'Find the item with barcode {code}' },
  'GET /api/items/bulk': { class: 'read', describe: 'List items as Add/Edit Multiple rows' },
  'POST /api/items/bulk': {
    class: 'bulk',
    describe: 'Add or change items in bulk',
    why: 'Add/Edit Multiple: one request saves every row (new items, edits of existing ones, opening stock posted to the ledger), all or nothing. dryRun: true only checks the rows.',
    countField: 'rows',
    dryRun: 'preview',
    bodySchema: '@/lib/validation/lists#bulkSchema',
  },
  'POST /api/items/change-prices': {
    class: 'bulk',
    describe: 'Change item prices by {value} ({adjustBy})',
    why: 'Change Item Prices: one request reprices many items. itemIds names them; without it every item (of itemType, when given) is repriced, and the answer\'s "changed" says how many. dryRun: true only previews.',
    countField: 'itemIds',
    dryRun: 'preview',
  },

  // Advanced pricing: price levels, price rules, quotes and the pricing preferences.
  'PATCH /api/pricing/customers/[id]': {
    class: 'change',
    describe: 'Set the customer type and price level of customer {id}',
  },
  'GET /api/pricing/levels': { class: 'read', describe: 'List price levels' },
  'POST /api/pricing/levels': { class: 'enter', describe: 'Add price level {name}' },
  'PUT /api/pricing/levels/[id]': { class: 'change', describe: 'Change price level {id}' },
  'DELETE /api/pricing/levels/[id]': {
    class: 'remove',
    describe: 'Delete price level {id} and take it off its customers',
  },
  'PUT /api/pricing/levels/[id]/items': {
    class: 'change',
    describe: 'Replace the item prices of price level {id}',
    why: 'The item prices belong to one price level and are replaced together, so it is one record changed, not bulk.',
  },
  'POST /api/pricing/quote': {
    class: 'read',
    describe: 'Work out the prices of document lines',
    why: 'Only computes prices for the lines sent (the document services work them out again on save); nothing is written.',
  },
  'GET /api/pricing/rules': { class: 'read', describe: 'List price rules' },
  'POST /api/pricing/rules': { class: 'enter', describe: 'Add price rule {name}' },
  'PUT /api/pricing/rules/[id]': { class: 'change', describe: 'Replace price rule {id}' },
  'DELETE /api/pricing/rules/[id]': { class: 'remove', describe: 'Delete price rule {id}' },
  'GET /api/pricing/settings': { class: 'read', describe: 'Show the advanced pricing settings' },
  'PATCH /api/pricing/settings': {
    class: 'settings',
    describe: 'Change the advanced pricing settings',
    why: 'Company pricing preferences (on or off, how conflicting rules are settled, rounding); plan section 8 puts pricing settings under settings.',
  },

  // Terms: due date and early-payment discount for a Terms entry.
  'GET /api/terms/compute': {
    class: 'read',
    describe: 'Work out the due date and discount for terms {terms}',
    why: 'Read only because ensureSeeded returns early when ctx.readOnly is true: for a person the first lookup saves the default Terms entries. The bridge must run it with ctx.readOnly set, not only a read-only database handle.',
  },
};
