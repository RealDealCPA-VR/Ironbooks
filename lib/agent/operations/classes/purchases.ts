/**
 * Agent full access: classification of the "purchases" routes (classes/buckets.ts lists the segments).
 * One entry per route + method, keyed "METHOD /api/pattern". Checked by classes/purchases.test.ts.
 *
 * Amounts (two-person approval, D8, and a grant's maxAmount), the same rule in every bucket:
 * amountField names the money the route's ANSWER carries (lib/agent/facts.ts takes the larger of
 * the body's and the answer's figure, so a typed figure the route ignores cannot lower it). Where the
 * answer lists one figure per row (a batch count's applied[].glAmount), a '*' path adds them up.
 * A request with no amount counts as over every amount limit until its dry run. After it the bridge
 * (lib/agent/bridge.ts factsFor) reads the run's whole ledger: the entries it posted, and the
 * entries already in the books that it voided, deleted or changed in place. With an amountField the
 * amount is the larger of that field and the largest SINGLE one of those entries, which is only the
 * largest row of a request that posts an entry per row (so those name their rows with '*'). With
 * none it is all of them added up, and "0.00" only for a run that made new records and posted no
 * entry; one that voided, deleted or changed a record already there and touched no entry stays
 * unknown. A void posts nothing new (it marks the existing entry void), but the bridge counts the
 * voided entry at its total, so a void is sized by the larger of its amountField and that entry.
 *
 * Confirmation flags: the bill payment and vendor credit body schemas carry allowReconciledEdit
 * because one schema serves the new record and the edit, but only the edit asks for it
 * (updateBillPayment, updateVendorCredit; a new record has no reconciled lines), so it is listed on
 * the PATCH entries alone.
 *
 * `id` names an operation where the id rule (registry.ts operationIdFor) would give the neutral
 * ".post", with a short verb: vendors.bulk.save, inventory.adjust, fifo.adjust.
 */
import type { ClassificationMap } from '../types';

// The default "Main Warehouse" site is created by ensureDefaultSite (lib/services/inventorySites.ts)
// the first time a person reads a company's sites, or by the first site operation of any kind. The
// reads (the site list, the by-site reports and the per-site reorder points, inventorySiteOps.ts
// listSiteReorderPoints) go through defaultSiteForRead, which makes it for a person only: an agent's
// read, or any context that only reads, gets what is there (no site yet, on such a company), so
// these GETs are plain reads.
const READS_DEFAULT_SITE =
  'Reads only. A person\'s first call on a company with no inventory site makes the default "Main Warehouse", ' +
  'as it always has; an agent\'s read, or any read-only one, never makes it (defaultSiteForRead, ' +
  'lib/services/inventorySites.ts) and answers as if no site had been set up yet: no sites, and the ' +
  'stock at no site until the default exists.';

// The reorder points read: before the default site exists, an item's own reorder point (Edit Item)
// is at no site yet, so only the stored per-site rows come back (inventorySiteOps.ts).
const READS_REORDER_POINTS =
  READS_DEFAULT_SITE +
  " Until then the list holds only the reorder points saved for a site; an item's own reorder point (Edit Item) is not at any site yet.";

// ensureSeeded (lib/services/lists/simpleLists.ts) saves the default Terms list on a person's first
// read; it returns early only when ctx.readOnly is set.
const SEEDS_TERMS_UNLESS_READ_ONLY =
  'Read only because ensureSeeded returns early when ctx.readOnly is true: for a person the first ' +
  'call saves the default Terms entries. The bridge must run it with ctx.readOnly set, not only a ' +
  'read-only database handle.';

// Vendor rows mask two kinds of data under two different flags (lib/permissions/mask.ts): taxId
// needs sensitivePayroll, accountNumber needs fullAccountNumbers. `reveal` holds one kind only.
const VENDOR_REVEAL =
  'Asking for full values shows the tax ID (flag sensitivePayroll). Our account number with the vendor ' +
  'is masked under a different flag (fullAccountNumbers), which this reveal does not cover.';

// The build routes import buildSiteFieldsSchema (lib/validation/inventorySites.ts), which covers
// only the optional site, bin, serial and lot fields; the rest is checked by hand. No full schema
// exists in lib/validation, so bodySchema is left out.
const PARTIAL_BUILD_SCHEMA =
  'The imported buildSiteFieldsSchema covers only the site, bin, serial and lot fields; the handler ' +
  'checks assemblyItemId, quantity and action by hand, so a body schema made from it is partial.';

export const PURCHASES_CLASSES: ClassificationMap = {
  // Vendors (Vendor Center). Tax IDs and our account number are masked unless the reader has the flag.
  'GET /api/vendors': {
    class: 'read',
    describe: 'List vendors',
    why: VENDOR_REVEAL,
    reveal: 'ssn',
    sensitiveFields: ['*.taxId', '*.accountNumber'],
  },
  'POST /api/vendors': {
    class: 'enter',
    describe: 'Add vendor {displayName}',
    // An opening balance posts a bill in the same save.
    amountField: 'openingBalance',
    sensitiveFields: ['taxId', 'accountNumber'],
  },
  'GET /api/vendors/[id]': {
    class: 'read',
    describe: 'Show vendor {id}',
    why: VENDOR_REVEAL,
    reveal: 'ssn',
    sensitiveFields: ['taxId', 'accountNumber'],
  },
  'PATCH /api/vendors/[id]': {
    class: 'change',
    describe: 'Change vendor {id}',
    sensitiveFields: ['taxId', 'accountNumber'],
  },
  'DELETE /api/vendors/[id]': {
    class: 'remove',
    describe: 'Make vendor {id} inactive',
    why:
      'Only makes the vendor inactive (its bills and history stay), but the app has no "make active" for ' +
      'vendors except Undo, so it is treated like a delete.',
    sensitiveFields: ['taxId', 'accountNumber'],
  },
  'GET /api/vendors/bulk': {
    class: 'read',
    describe: 'List vendors as rows for Add/Edit Multiple',
    why: SEEDS_TERMS_UNLESS_READ_ONLY,
  },
  'POST /api/vendors/bulk': {
    class: 'bulk',
    id: 'vendors.bulk.save',
    describe: 'Add or change several vendors at once',
    why: 'Add/Edit Multiple: one request saves every row (new vendors, and edits of existing ones when a row has an id), all or nothing. Its preview option is dryRun: true in the body: every row is checked and the whole batch rolled back, so nothing is saved.',
    countField: 'rows',
    dryRun: 'preview',
    bodySchema: '@/lib/validation/lists#bulkSchema',
  },

  // Bills (Enter Bills, Pay Bills list). DELETE voids the bill; it stays on file.
  'GET /api/bills': { class: 'read', describe: 'List bills' },
  'POST /api/bills': {
    class: 'enter',
    describe: 'Enter a bill from vendor {vendorId}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'GET /api/bills/duplicate-number': {
    class: 'read',
    describe: 'Check whether vendor {vendorId} already has bill number {billNumber}',
  },
  'GET /api/bills/to-pay': {
    class: 'read',
    describe: 'List open bills to pay',
    why: SEEDS_TERMS_UNLESS_READ_ONLY,
  },
  'GET /api/bills/[id]': { class: 'read', describe: 'Show bill {id}' },
  'PATCH /api/bills/[id]': {
    class: 'change',
    describe: 'Change bill {id}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'DELETE /api/bills/[id]': {
    class: 'change',
    describe: 'Void bill {id}',
    why: 'Voids the bill (reverses its entry and keeps it on file marked void); nothing is deleted.',
    amountField: 'total',
  },

  // Bill payments (Pay Bills). DELETE voids the payment; it stays on file.
  'GET /api/bill-payments': { class: 'read', describe: 'List bill payments' },
  'POST /api/bill-payments': {
    class: 'change',
    describe: 'Pay bills of vendor {vendorId}, applying any credits picked',
    why:
      'Classed by its riskiest part. One Pay Bills save (payBillsWithCredits) can also apply vendor credits ' +
      'and General Journal credits to existing bills, which is a change, and a save with credits only ' +
      'makes no payment at all (payment is null). The amount is the larger of the cash paid and the ' +
      'credits applied, so a $1 check that applies a $50,000 credit is judged at $50,000: amountField is ' +
      'the answer\'s creditsApplied (one total of every credit used), and the cash payment posts its own ' +
      'new ledger entry, which the bridge takes when it is larger. A save that both pays and applies ' +
      'credits is judged by the larger of the two, not their sum. Until the dry run has answered, the ' +
      'amount is unknown and counts as over every amount limit.',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'creditsApplied',
  },
  'GET /api/bill-payments/[id]': { class: 'read', describe: 'Show bill payment {id}' },
  'PATCH /api/bill-payments/[id]': {
    class: 'change',
    describe: 'Change bill payment {id}',
    confirmFlags: ['allowDuplicateNumber', 'allowReconciledEdit'],
    amountField: 'amount',
  },
  'DELETE /api/bill-payments/[id]': {
    class: 'change',
    describe: 'Void bill payment {id}',
    why: 'Voids the payment (reverses its entry, reopens the bills, keeps it on file marked void); nothing is deleted.',
    amountField: 'amount',
  },
  'GET /api/bill-payments/journal-items': {
    class: 'read',
    describe: 'List General Journal amounts owed to and credits from vendor {vendorId}',
  },
  'POST /api/bill-payments/journal-items': {
    class: 'change',
    id: 'bill-payments.journal-items.apply',
    describe: 'Apply or remove a General Journal vendor credit (action: {action})',
    why: 'Applies a General Journal credit to a bill or amount owed, or takes one off: applying credits is a change.',
    amountField: 'amount',
  },

  // Vendor credits. POST /[id] applies, unapplies or refunds; DELETE voids.
  'GET /api/vendor-credits': { class: 'read', describe: 'List vendor credits' },
  'POST /api/vendor-credits': {
    class: 'enter',
    describe: 'Enter a credit from vendor {vendorId}',
    amountField: 'total',
  },
  'GET /api/vendor-credits/[id]': { class: 'read', describe: 'Show vendor credit {id}' },
  'POST /api/vendor-credits/[id]': {
    class: 'change',
    describe: 'Apply, unapply or refund vendor credit {id} (action: {action}, amount: {amount})',
    why:
      'Applies the credit to a bill or takes it off (a change), or records the vendor\'s refund into a bank ' +
      'account (a new deposit, no higher than change).',
    amountField: 'amount',
  },
  'PATCH /api/vendor-credits/[id]': {
    class: 'change',
    describe: 'Change vendor credit {id}',
    confirmFlags: ['allowReconciledEdit'],
    amountField: 'total',
  },
  'DELETE /api/vendor-credits/[id]': {
    class: 'change',
    describe: 'Void vendor credit {id}',
    why: 'Voids the credit (reverses its entry and returned stock, keeps it on file marked void); nothing is deleted.',
    amountField: 'total',
  },
  'GET /api/vendor-credits/[id]/pdf': {
    class: 'read',
    describe: 'Make the PDF of vendor credit {id}',
    output: 'pdf',
  },

  // Purchase orders. POST /[id] converts to a bill, voids or closes; DELETE removes the order for good.
  'GET /api/purchase-orders': { class: 'read', describe: 'List purchase orders' },
  'POST /api/purchase-orders': {
    class: 'enter',
    describe: 'Enter a purchase order to vendor {vendorId}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'GET /api/purchase-orders/[id]': { class: 'read', describe: 'Show purchase order {id}' },
  'POST /api/purchase-orders/[id]': {
    class: 'change',
    describe: 'Turn purchase order {id} into a bill, void it or close it (action: {action})',
    why:
      'convert enters the bill for the order (posting what was pending), void and close change the order\'s ' +
      'status: all changes to an existing record.',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'PATCH /api/purchase-orders/[id]': {
    class: 'change',
    describe: 'Change purchase order {id}',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'DELETE /api/purchase-orders/[id]': { class: 'remove', describe: 'Delete purchase order {id}' },
  'POST /api/purchase-orders/[id]/email': {
    class: 'outside',
    describe: 'Email purchase order {id} to {to}',
    why: 'Sends the purchase order PDF by email to the vendor (or to the address given).',
    effects: ['email'],
  },
  'GET /api/purchase-orders/[id]/pdf': {
    class: 'read',
    describe: 'Make the PDF of purchase order {id}',
    output: 'pdf',
  },

  // Receiving (Enter Bill for Received Items, enhanced receiving preferences).
  'POST /api/receiving/bill': {
    class: 'enter',
    describe: 'Enter a bill for items received from vendor {vendorId}',
    why: 'Enters and posts the bill for items already received. Its preview option is preview: true in the body: the route answers the price variances and the journal entry it would post, and saves nothing.',
    confirmFlags: ['allowDuplicateNumber'],
    dryRun: 'preview',
    // The posted answer is the bill row (total), as for POST /api/bills. The route's own preview
    // answers the same figure as billTotal (and as preview.billTotal in the posted answer).
    amountField: 'total',
  },
  'GET /api/receiving/open-lines': {
    class: 'read',
    describe: 'List items received from vendor {vendorId} and not billed yet',
  },
  'GET /api/receiving/po/[id]': {
    class: 'read',
    describe: 'Show what was ordered, received and billed on purchase order {id}',
  },
  'GET /api/receiving/settings': { class: 'read', describe: 'Show the receiving preferences' },
  'PATCH /api/receiving/settings': {
    class: 'settings',
    describe: 'Change the receiving preferences',
    why: 'Company preference (enhanced receiving, price variance account); turning it on or off also re-works open purchase order statuses.',
  },

  // Expense reports. A report starts as a draft; POST /[id] submits it or reimburses it (posts and pays).
  'GET /api/expense-reports': { class: 'read', describe: 'List expense reports' },
  'POST /api/expense-reports': {
    class: 'enter',
    describe: 'Enter an expense report for employee {employeeId}',
    amountField: 'total',
  },
  'GET /api/expense-reports/[id]': { class: 'read', describe: 'Show expense report {id}' },
  'POST /api/expense-reports/[id]': {
    class: 'change',
    describe: 'Submit or reimburse expense report {id} (action: {action})',
    why: 'submit moves the draft on; reimburse posts the report and pays the employee from a bank account (posting a pending one).',
    amountField: 'total',
  },

  // Item receipts (Receive Items). POST /[id] converts to a bill or voids.
  'GET /api/item-receipts': { class: 'read', describe: 'List item receipts' },
  'POST /api/item-receipts': {
    class: 'enter',
    describe: 'Receive items from vendor {vendorId}',
    amountField: 'total',
  },
  'GET /api/item-receipts/[id]': { class: 'read', describe: 'Show item receipt {id}' },
  'POST /api/item-receipts/[id]': {
    class: 'change',
    describe: 'Turn item receipt {id} into a bill, or void it (action: {action})',
    why: 'convert enters the bill for the received items (posting what was pending); void reverses the receipt.',
    confirmFlags: ['allowDuplicateNumber'],
    amountField: 'total',
  },
  'PATCH /api/item-receipts/[id]': {
    class: 'change',
    describe: 'Change item receipt {id}',
    amountField: 'total',
  },

  // Inventory: valuation, counts, adjustments, reorder list. The adjustments post a ledger entry
  // whose amount is in the answer only (glAmount, or the signed delta of a value adjustment).
  'GET /api/inventory': { class: 'read', describe: 'Show the inventory valuation' },
  'POST /api/inventory': {
    class: 'enter',
    id: 'inventory.adjust',
    describe: 'Adjust the quantity of item {itemId} (action: {action})',
    amountField: 'glAmount',
  },
  'POST /api/inventory/batch-count': {
    class: 'bulk',
    describe: 'Record a physical count of several items on {date}',
    why:
      'Posts one quantity adjustment per counted item, each its own ledger entry. The amount is the size of ' +
      'all of them together: each counted item has its own glAmount under applied in the answer, and ' +
      'applied.*.glAmount adds them up (shrinkage and overage both count by size). With an amountField the ' +
      'bridge compares the field only with the largest single entry, so the field must be the whole count\'s.',
    countField: 'counts',
    amountField: 'applied.*.glAmount',
  },
  'GET /api/inventory/center': { class: 'read', describe: 'List items in the Inventory Center' },
  'GET /api/inventory/center/[id]': { class: 'read', describe: 'Show inventory item {id}' },
  'POST /api/inventory/physical-count': {
    class: 'enter',
    describe: 'Record a physical count of {countedQty} for item {itemId} on {date}',
    amountField: 'glAmount',
  },
  'GET /api/inventory/reorder': { class: 'read', describe: 'List items to reorder' },
  'POST /api/inventory/reorder/create-po': {
    class: 'bulk',
    describe: 'Make purchase orders from the reorder list',
    why:
      'Makes one purchase order per preferred vendor. itemIds is an upper bound on the count; without it the ' +
      'whole reorder list is used. Its preview option is dryRun: true in the body: it lists the orders it would make and saves none.',
    countField: 'itemIds',
    dryRun: 'preview',
  },
  'GET /api/inventory/stock-by-vendor': { class: 'read', describe: 'Show inventory stock status by vendor' },
  'GET /api/inventory/stock-status': { class: 'read', describe: 'Show inventory stock status by item' },
  'POST /api/inventory/value-adjust': {
    class: 'enter',
    describe: 'Adjust the value of item {itemId} on {date}',
    // Signed: positive writes the value up, negative writes it down (the policy compares its size).
    amountField: 'delta',
  },
  'GET /api/inventory/worksheet': {
    class: 'read',
    describe: 'Show the physical inventory worksheet',
    why: '?format=csv answers the same worksheet as a CSV file (text/csv, a download) instead of JSON, so the output is marked "file": a caller must go by the answer\'s content type, never parse it as JSON unseen.',
    output: 'file',
  },

  // Inventory sites, bins and per-site reorder points (Advanced Inventory).
  'GET /api/inventory-sites': {
    class: 'read',
    describe: 'List inventory sites',
    why: READS_DEFAULT_SITE,
  },
  'POST /api/inventory-sites': { class: 'enter', describe: 'Add inventory site {name}' },
  'GET /api/inventory-sites/[id]': { class: 'read', describe: 'Show inventory site {id}' },
  'PATCH /api/inventory-sites/[id]': { class: 'change', describe: 'Change inventory site {id}' },
  'POST /api/inventory-sites/adjust': {
    class: 'enter',
    describe: 'Adjust the quantity of item {itemId} at a site by {quantityChange}',
    amountField: 'glAmount',
  },
  'GET /api/inventory-sites/bins': { class: 'read', describe: 'List bins' },
  'POST /api/inventory-sites/bins': { class: 'enter', describe: 'Add bin {name}' },
  'PATCH /api/inventory-sites/bins/[id]': { class: 'change', describe: 'Change bin {id}' },
  'GET /api/inventory-sites/reorder-points': {
    class: 'read',
    describe: 'List reorder points by site',
    why: READS_REORDER_POINTS,
  },
  'PUT /api/inventory-sites/reorder-points': {
    class: 'change',
    describe: 'Set the reorder point of item {itemId} at site {siteId}',
  },
  'GET /api/inventory-sites/reports': {
    class: 'read',
    describe: 'Run the inventory-by-site report {report}',
    why: READS_DEFAULT_SITE,
  },

  // Inventory transfers between sites. POST /[id] voids.
  'GET /api/inventory-transfers': { class: 'read', describe: 'List inventory transfers' },
  'POST /api/inventory-transfers': {
    class: 'enter',
    describe: 'Transfer inventory from site {fromSiteId} to site {toSiteId}',
  },
  'GET /api/inventory-transfers/[id]': { class: 'read', describe: 'Show inventory transfer {id}' },
  'POST /api/inventory-transfers/[id]': {
    class: 'change',
    describe: 'Void inventory transfer {id}',
    why: 'The only action is void: the transfer stays on file marked void.',
  },

  // Assemblies: bill of materials, builds, pending builds.
  'GET /api/assemblies': {
    class: 'read',
    describe: 'Show the components of assembly {assemblyItemId}',
  },
  'PUT /api/assemblies': {
    class: 'change',
    describe: 'Replace the components of assembly {assemblyItemId}',
  },
  'PATCH /api/assemblies': {
    class: 'change',
    describe: 'Replace the components of assembly {assemblyItemId}',
  },
  'POST /api/assemblies/build': {
    class: 'enter',
    describe: 'Build or unbuild {quantity} of assembly {assemblyItemId} (action: {action})',
    why: PARTIAL_BUILD_SCHEMA,
  },
  'GET /api/assemblies/pending': { class: 'read', describe: 'List pending builds' },
  // A pending build is a transaction like a purchase order: it posts nothing until finalized, but
  // it reserves its components' stock at once (lib/services/fulfillment.ts lowers what open sales
  // orders can ship) and shows in reminders. So it is entered, not merely prepared.
  'POST /api/assemblies/pending': {
    class: 'enter',
    describe: 'Queue a pending build of {quantity} of assembly {assemblyItemId}',
  },
  'POST /api/assemblies/pending/[id]': {
    class: 'change',
    describe: 'Finalize or cancel pending build {id} (action: {action})',
    why: 'finalize builds the queued quantity (posting a pending one); cancel drops it. ' + PARTIAL_BUILD_SCHEMA,
  },

  // FIFO cost layers.
  'GET /api/fifo': { class: 'read', describe: 'Show the FIFO inventory valuation' },
  'POST /api/fifo': {
    class: 'enter',
    id: 'fifo.adjust',
    describe: 'Receive or use stock of item {itemId} at FIFO cost (action: {action})',
    amountField: 'glAmount',
  },

  // Landed cost. POST /[id] voids an allocation.
  'GET /api/landed-cost': { class: 'read', describe: 'List landed-cost allocations' },
  'POST /api/landed-cost': {
    class: 'enter',
    describe: 'Spread a bill charge from bill {billId} over item receipts as landed cost',
    amountField: 'amount',
  },
  'GET /api/landed-cost/[id]': { class: 'read', describe: 'Show landed-cost allocation {id}' },
  'POST /api/landed-cost/[id]': {
    class: 'change',
    describe: 'Void landed-cost allocation {id}',
    why: 'The only action is void: an exact reversal; the allocation stays on file marked void.',
    amountField: 'amount',
  },
  'POST /api/landed-cost/preview': {
    class: 'read',
    describe: 'Preview spreading a bill charge from bill {billId} as landed cost',
    why: 'Only works out the split (amount, inventory, cost of goods sold per line); nothing is saved.',
  },
};
