import { pgTable, uuid, varchar, text, timestamp, boolean, decimal, integer, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums
export const accountTypeEnum = pgEnum('account_type', ['asset', 'liability', 'equity', 'revenue', 'expense']);
export const accountSubtypeEnum = pgEnum('account_subtype', [
  'checking', 'savings', 'accounts_receivable', 'inventory', 'fixed_assets',
  'accounts_payable', 'credit_card', 'long_term_liability',
  'owners_equity', 'retained_earnings',
  'sales', 'service_revenue', 'other_income',
  'cost_of_goods_sold', 'operating_expenses', 'payroll', 'taxes',
  // wave2 foundation (0025): full QuickBooks account-type list (see lib/accountTypes.ts)
  'other_current_asset', 'undeposited_funds', 'other_asset', 'other_current_liability',
  'other_expense', 'non_posting',
]);
export const journalEntryStatusEnum = pgEnum('journal_entry_status', ['draft', 'posted', 'void']);
export const userRoleEnum = pgEnum('user_role', ['owner', 'admin', 'accountant', 'viewer']);
export const fileTypeEnum = pgEnum('file_type', ['qbo', 'qbx', 'iif', 'ofx', 'csv']);
export const importStatusEnum = pgEnum('import_status', ['pending', 'processing', 'completed', 'failed']);
export const errorSeverityEnum = pgEnum('error_severity', ['low', 'medium', 'high', 'critical']);
export const errorTypeEnum = pgEnum('error_type', [
  'duplicate', 'unbalanced', 'miscategorized', 'missing_field', 
  'date_inconsistency', 'unusual_pattern', 'account_mismatch'
]);
export const correctionStatusEnum = pgEnum('correction_status', ['pending', 'approved', 'rejected', 'applied']);
export const auditActionEnum = pgEnum('audit_action', ['create', 'update', 'delete', 'void', 'llm_correction']);

// Users
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  resetToken: text('reset_token'),
  resetExpires: timestamp('reset_expires'),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  /** gapsb (0056): when the password was last set — password expiry counts from here. */
  passwordChangedAt: timestamp('password_changed_at'),
  /** gapsb (0056): the next sign-in must choose a new password (expired / admin asked). */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  /** 0062: challenge question for "I forgot my password" (lib/challengeQuestions.ts). */
  challengeQuestion: text('challenge_question'),
  /** 0062: bcrypt of the normalized challenge answer. */
  challengeAnswerHash: text('challenge_answer_hash'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Companies
export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  ownerId: uuid('owner_id').references(() => users.id).notNull(),
  settings: jsonb('settings').$type<{
    fiscalYearEnd?: string;
    currency?: string;
    timezone?: string;
    [key: string]: any;
  }>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// User-Company relationship (many-to-many with roles)
export const userCompanies = pgTable('user_companies', {
  userId: uuid('user_id').references(() => users.id).notNull(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  role: userRoleEnum('role').notNull().default('viewer'),
  /** Deactivated members cannot sign in to / act in this company (team users, 0021). */
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Chart of Accounts
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  code: varchar('code', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  type: accountTypeEnum('type').notNull(),
  subtype: accountSubtypeEnum('subtype').notNull(),
  parentId: uuid('parent_id').references((): any => accounts.id),
  balance: decimal('balance', { precision: 15, scale: 2 }).notNull().default('0'),
  isActive: boolean('is_active').notNull().default(true),
  description: text('description'),
  /** Income-tax line this account rolls up to (lib/taxLines.ts key, e.g. "1120:L1a"); wave2 foundation. */
  taxLine: varchar('tax_line', { length: 40 }),
  /** wave2 purchases: currency of a bank / credit-card account (null = home currency). */
  currency: varchar('currency', { length: 3 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  /** Record-locking version: moves on edits only, not balance changes (P1 controls, 0046). */
  editedAt: timestamp('edited_at').defaultNow().notNull(),
});

// Journal Entries (Transaction Headers)
export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  entryNumber: integer('entry_number').notNull(),
  date: timestamp('date').notNull(),
  description: text('description').notNull(),
  reference: varchar('reference', { length: 100 }),
  status: journalEntryStatusEnum('status').notNull().default('draft'),
  /** Link to the source document, e.g. "invoice:<id>" — enables drill-down + duplicate-post guards. */
  sourceRef: varchar('source_ref', { length: 255 }),
  /** QB "Adjusting Entry" checkbox (accountant adjustments); wave2 foundation. */
  isAdjusting: boolean('is_adjusting').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  voidedAt: timestamp('voided_at'),
});

// Journal Entry Lines (Debits and Credits)
export const journalEntryLines = pgTable('journal_entry_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  debit: decimal('debit', { precision: 15, scale: 2 }),
  credit: decimal('credit', { precision: 15, scale: 2 }),
  memo: text('memo'),
  classId: uuid('class_id').references((): any => classes.id), // class/department tracking dimension
  /** QB "Name" column: 'customer' | 'vendor' | 'employee' | 'other' (wave2 foundation). */
  entityType: varchar('entity_type', { length: 20 }),
  /** Id of the customer / vendor / employee / other name (polymorphic, no FK). */
  entityId: uuid('entity_id'),
  /** p1 fx (0043): account-currency amount of a line on a foreign-currency bank / credit-card
   * account (same side as debit/credit; 0 = a home-currency-only revaluation line), its currency
   * and the home units per 1 foreign unit. Null on home-currency lines. */
  currency: varchar('currency', { length: 3 }),
  foreignAmount: decimal('foreign_amount', { precision: 15, scale: 2 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Bank Accounts
export const bankAccounts = pgTable('bank_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  bankName: varchar('bank_name', { length: 255 }).notNull(),
  accountNumber: text('account_number').notNull(), // Should be encrypted
  lastReconciledDate: timestamp('last_reconciled_date'),
  lastReconciledBalance: decimal('last_reconciled_balance', { precision: 15, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Reconciliations
export const reconciliations = pgTable('reconciliations', {
  id: uuid('id').primaryKey().defaultRandom(),
  bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id).notNull(),
  statementDate: timestamp('statement_date').notNull(),
  statementBalance: decimal('statement_balance', { precision: 15, scale: 2 }).notNull(),
  reconciledBalance: decimal('reconciled_balance', { precision: 15, scale: 2 }),
  status: varchar('status', { length: 50 }).notNull().default('in_progress'),
  createdBy: uuid('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

// Reconciliation Items
export const reconciliationItems = pgTable('reconciliation_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  reconciliationId: uuid('reconciliation_id').references(() => reconciliations.id).notNull(),
  journalEntryLineId: uuid('journal_entry_line_id').references(() => journalEntryLines.id).notNull(),
  isCleared: boolean('is_cleared').notNull().default(false),
  clearedDate: timestamp('cleared_date'),
});

// File Imports
export const fileImports = pgTable('file_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  filename: varchar('filename', { length: 255 }).notNull(),
  fileType: fileTypeEnum('file_type').notNull(),
  status: importStatusEnum('status').notNull().default('pending'),
  totalTransactions: integer('total_transactions').default(0),
  importedTransactions: integer('imported_transactions').default(0),
  failedTransactions: integer('failed_transactions').default(0),
  errorLog: jsonb('error_log').$type<Array<{ line: number; error: string }>>(),
  uploadedBy: uuid('uploaded_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

// Error Detections
export const errorDetections = pgTable('error_detections', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
  errorType: errorTypeEnum('error_type').notNull(),
  severity: errorSeverityEnum('severity').notNull(),
  description: text('description').notNull(),
  detectedAt: timestamp('detected_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
});

// Error Corrections
export const errorCorrections = pgTable('error_corrections', {
  id: uuid('id').primaryKey().defaultRandom(),
  errorDetectionId: uuid('error_detection_id').references(() => errorDetections.id).notNull(),
  suggestedBy: varchar('suggested_by', { length: 50 }).notNull(), // 'system', 'llm', 'user'
  correctionType: varchar('correction_type', { length: 50 }).notNull(),
  correctionData: jsonb('correction_data').$type<{
    action: string;
    changes: any;
    reasoning?: string;
  }>(),
  llmReasoning: text('llm_reasoning'),
  status: correctionStatusEnum('status').notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  appliedAt: timestamp('applied_at'),
});

// Audit Logs
// Indexes (hand-written migrations): (company_id, created_at) 0029; (company_id, entity_type, entity_id) 0067.
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  userId: uuid('user_id').references(() => users.id),
  action: auditActionEnum('action').notNull(),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  oldValues: jsonb('old_values'),
  newValues: jsonb('new_values'),
  llmReasoning: text('llm_reasoning'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  companies: many(userCompanies),
  journalEntries: many(journalEntries),
}));

export const companiesRelations = relations(companies, ({ one, many }) => ({
  owner: one(users, {
    fields: [companies.ownerId],
    references: [users.id],
  }),
  users: many(userCompanies),
  accounts: many(accounts),
  journalEntries: many(journalEntries),
  fileImports: many(fileImports),
  errorDetections: many(errorDetections),
  auditLogs: many(auditLogs),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  company: one(companies, {
    fields: [accounts.companyId],
    references: [companies.id],
  }),
  parent: one(accounts, {
    fields: [accounts.parentId],
    references: [accounts.id],
  }),
  children: many(accounts),
  journalEntryLines: many(journalEntryLines),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one, many }) => ({
  company: one(companies, {
    fields: [journalEntries.companyId],
    references: [companies.id],
  }),
  createdBy: one(users, {
    fields: [journalEntries.createdBy],
    references: [users.id],
  }),
  lines: many(journalEntryLines),
  errorDetections: many(errorDetections),
}));

export const journalEntryLinesRelations = relations(journalEntryLines, ({ one }) => ({
  journalEntry: one(journalEntries, {
    fields: [journalEntryLines.journalEntryId],
    references: [journalEntries.id],
  }),
  account: one(accounts, {
    fields: [journalEntryLines.accountId],
    references: [accounts.id],
  }),
}));

export const errorDetectionsRelations = relations(errorDetections, ({ one, many }) => ({
  company: one(companies, {
    fields: [errorDetections.companyId],
    references: [companies.id],
  }),
  journalEntry: one(journalEntries, {
    fields: [errorDetections.journalEntryId],
    references: [journalEntries.id],
  }),
  corrections: many(errorCorrections),
}));

export const errorCorrectionsRelations = relations(errorCorrections, ({ one }) => ({
  errorDetection: one(errorDetections, {
    fields: [errorCorrections.errorDetectionId],
    references: [errorDetections.id],
  }),
  reviewedBy: one(users, {
    fields: [errorCorrections.reviewedBy],
    references: [users.id],
  }),
}));

// ============================================================================
// EXTENDED SCHEMA — QuickBooks-parity master data & transactional documents.
// Every transactional document references the journal entry it posts to
// (`postedEntryId`), so the GL remains the single source of truth and the
// posting engine stays the only writer of balances.
// ============================================================================

export const itemTypeEnum = pgEnum('item_type', [
  'service', 'inventory', 'non_inventory', 'bundle',
  // QB Desktop parity item types (non-posting or special-posting line helpers):
  'other_charge', 'discount', 'subtotal', 'payment', 'sales_tax',
]);
export const docStatusEnum = pgEnum('doc_status', [
  'draft', 'open', 'partial', 'paid', 'overdue', 'void', 'closed', 'accepted', 'rejected',
]);
export const paymentMethodEnum = pgEnum('payment_method', [
  'cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other',
]);
export const payTypeEnum = pgEnum('pay_type', ['hourly', 'salary', 'commission']);

// ---- Tracking dimensions ----
export const classes = pgTable('classes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  parentId: uuid('parent_id').references((): any => classes.id),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Customers / Vendors ----
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  billingAddress: jsonb('billing_address').$type<Record<string, string>>(),
  shippingAddress: jsonb('shipping_address').$type<Record<string, string>>(),
  /** p1/salesforms: named ship-to addresses ({ name, line1.., isDefault }); drizzle/0040. */
  shipToAddresses: jsonb('ship_to_addresses').$type<Array<Record<string, string | boolean>>>(),
  terms: varchar('terms', { length: 50 }).default('net_30'),
  creditLimit: decimal('credit_limit', { precision: 15, scale: 2 }),
  taxable: boolean('taxable').notNull().default(true),
  taxRateId: uuid('tax_rate_id'),
  parentId: uuid('parent_id').references((): any => customers.id), // sub-customers / jobs
  balance: decimal('balance', { precision: 15, scale: 2 }).notNull().default('0'),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  /** Values for company-defined custom fields ({ [fieldName]: value }). */
  customFields: jsonb('custom_fields').$type<Record<string, string>>(),
  /** Advanced pricing (team pricing): customer type list + assigned price level. */
  customerTypeId: uuid('customer_type_id'),
  priceLevelId: uuid('price_level_id'),
  /** Wave-2 lists: default payment terms (Terms list), sales tax code, resale number, exemption. */
  termsId: uuid('terms_id').references((): any => paymentTerms.id),
  salesTaxCodeId: uuid('sales_tax_code_id').references((): any => salesTaxCodes.id),
  resaleNumber: varchar('resale_number', { length: 50 }),
  taxExemptionReason: varchar('tax_exemption_reason', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  address: jsonb('address').$type<Record<string, string>>(),
  terms: varchar('terms', { length: 50 }).default('net_30'),
  is1099: boolean('is_1099').notNull().default(false),
  taxId: text('tax_id'), // encrypted at rest
  defaultExpenseAccountId: uuid('default_expense_account_id').references(() => accounts.id),
  balance: decimal('balance', { precision: 15, scale: 2 }).notNull().default('0'),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  /** Values for company-defined custom fields ({ [fieldName]: value }). */
  customFields: jsonb('custom_fields').$type<Record<string, string>>(),
  /** Vendor type list (team pricing). */
  vendorTypeId: uuid('vendor_type_id'),
  /** Wave-2 lists: default payment terms (Terms list) and billing rate level for time billing. */
  termsId: uuid('terms_id').references((): any => paymentTerms.id),
  billingRateLevelId: uuid('billing_rate_level_id').references((): any => billingRateLevels.id),
  // wave2 purchases: QB vendor fields - up to 3 pre-fill accounts, "print on check as" name,
  // the account number the vendor knows us by (printed on the check memo), and the vendor's currency.
  prefillAccountIds: jsonb('prefill_account_ids').$type<string[]>(),
  printOnCheckAs: varchar('print_on_check_as', { length: 255 }),
  accountNumber: varchar('account_number', { length: 100 }),
  currency: varchar('currency', { length: 3 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ---- Products & Services ----
export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  sku: varchar('sku', { length: 100 }),
  type: itemTypeEnum('type').notNull().default('service'),
  description: text('description'),
  salesPrice: decimal('sales_price', { precision: 15, scale: 2 }),
  purchaseCost: decimal('purchase_cost', { precision: 15, scale: 2 }),
  incomeAccountId: uuid('income_account_id').references(() => accounts.id),
  expenseAccountId: uuid('expense_account_id').references(() => accounts.id),
  assetAccountId: uuid('asset_account_id').references(() => accounts.id), // inventory asset
  taxable: boolean('taxable').notNull().default(true),
  unitOfMeasure: varchar('unit_of_measure', { length: 50 }),
  // inventory tracking
  quantityOnHand: decimal('quantity_on_hand', { precision: 15, scale: 4 }).default('0'),
  reorderPoint: decimal('reorder_point', { precision: 15, scale: 4 }),
  averageCost: decimal('average_cost', { precision: 15, scale: 4 }),
  /**
   * Average cost: the cents the inventory GL carries for the item beyond its book value
   * round2(quantityOnHand × averageCost) — a receipt the 4dp average cannot represent (3000 for
   * $1000). Relieved with the last unit (lib/services/inventory.ts valueRemainderAfter /
   * carriedValueRemainder). Only valid while averageCost equals valueRemainderAvg (0061).
   */
  valueRemainder: decimal('value_remainder', { precision: 15, scale: 2 }).notNull().default('0'),
  valueRemainderAvg: decimal('value_remainder_avg', { precision: 15, scale: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  /** Values for company-defined custom fields ({ [fieldName]: value }). */
  customFields: jsonb('custom_fields').$type<Record<string, string>>(),
  // Advanced Inventory (team inventory): scan code (unique per company), serial/lot
  // tracking mode ('none' | 'serial' | 'lot'), and unit weight for landed-cost allocation.
  barcode: varchar('barcode', { length: 100 }),
  trackingMode: varchar('tracking_mode', { length: 10 }).notNull().default('none'),
  weight: decimal('weight', { precision: 15, scale: 4 }),
  /** Wave-2 lists: preferred vendor (reorder → PO), sales tax code, unit of measure set. */
  preferredVendorId: uuid('preferred_vendor_id').references((): any => vendors.id),
  salesTaxCodeId: uuid('sales_tax_code_id').references((): any => salesTaxCodes.id),
  uomSetId: uuid('uom_set_id').references((): any => uomSets.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  /**
   * Record-locking version (lib/services/concurrency.ts): moves on every change EXCEPT the stock
   * figures (quantity on hand, average cost, value remainder) that sales and receipts write, so
   * selling an item never makes an open Edit Item form stale (bka_version_items, 0067).
   */
  editedAt: timestamp('edited_at').defaultNow().notNull(),
});

// ---- Sales tax ----
export const taxAgencies = pgTable('tax_agencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  liabilityAccountId: uuid('liability_account_id').references(() => accounts.id),
  /** p1 purchases: the vendor Sales Tax Payment checks are written to (QB agencies are vendors). */
  vendorId: uuid('vendor_id').references((): any => vendors.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const taxRates = pgTable('tax_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  rate: decimal('rate', { precision: 9, scale: 6 }).notNull(), // e.g. 0.082500
  agencyId: uuid('agency_id').references(() => taxAgencies.id),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Estimates ----
export const estimates = pgTable('estimates', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  estimateNumber: integer('estimate_number').notNull(),
  /** Alphanumeric document number shown to users (e.g. "INV-1001"); see lib/services/docNumbers.ts. */
  refNumber: varchar('ref_number', { length: 50 }),
  date: timestamp('date').notNull(),
  expirationDate: timestamp('expiration_date'),
  status: docStatusEnum('status').notNull().default('draft'),
  subtotal: decimal('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
  taxAmount: decimal('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  convertedInvoiceId: uuid('converted_invoice_id'),
  /** Total billed so far via progress invoicing (≤ total). */
  amountInvoiced: decimal('amount_invoiced', { precision: 15, scale: 2 }).notNull().default('0'),
  /** fix/sales (0036): amount billed by the old dollar-only progress invoicing (before line links). */
  priorAmountInvoiced: decimal('prior_amount_invoiced', { precision: 15, scale: 2 }).notNull().default('0'),
  /** wave2 sales: quoted tax rate (kept so the estimate can be edited later). */
  taxRateId: uuid('tax_rate_id'),
  /** p1/salesforms: ship-to address (drizzle/0040). */
  shipTo: jsonb('ship_to').$type<Record<string, string>>(),
  toBePrinted: boolean('to_be_printed').notNull().default(false),
  toBeEmailed: boolean('to_be_emailed').notNull().default(false),
  lastEmailedAt: timestamp('last_emailed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const estimateLines = pgTable('estimate_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  estimateId: uuid('estimate_id').references(() => estimates.id).notNull(),
  itemId: uuid('item_id').references(() => items.id),
  description: text('description'),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
  rate: decimal('rate', { precision: 15, scale: 4 }).notNull().default('0'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  taxable: boolean('taxable').notNull().default(true),
  lineOrder: integer('line_order').notNull().default(0),
  /** Advanced pricing: which price rule/level priced this line (lib/services/pricing.ts). */
  pricing: jsonb('pricing').$type<Record<string, unknown>>(),
  /** fix/sales (0036): class carried onto the invoice lines that bill this estimate line. */
  classId: uuid('class_id'),
  /** fix/sales (0036): billed before per-line links existed (backfill); new billing is linked. */
  priorQtyInvoiced: decimal('prior_qty_invoiced', { precision: 15, scale: 4 }).notNull().default('0'),
  priorAmountInvoiced: decimal('prior_amount_invoiced', { precision: 15, scale: 2 }).notNull().default('0'),
});

// ---- Invoices (A/R) ----
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  invoiceNumber: integer('invoice_number').notNull(),
  /** Alphanumeric document number shown to users (e.g. "INV-1001"); see lib/services/docNumbers.ts. */
  refNumber: varchar('ref_number', { length: 50 }),
  date: timestamp('date').notNull(),
  dueDate: timestamp('due_date'),
  terms: varchar('terms', { length: 50 }),
  status: docStatusEnum('status').notNull().default('open'),
  classId: uuid('class_id').references(() => classes.id),
  locationId: uuid('location_id').references(() => locations.id),
  taxRateId: uuid('tax_rate_id').references(() => taxRates.id),
  salesRepId: uuid('sales_rep_id').references((): any => salesReps.id),
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  discountType: varchar('discount_type', { length: 10 }).default('amount'), // 'amount' | 'percent'
  retainagePercent: decimal('retainage_percent', { precision: 5, scale: 2 }),
  retainageAmount: decimal('retainage_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  jobId: uuid('job_id').references((): any => jobs.id),
  subtotal: decimal('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
  discount: decimal('discount', { precision: 15, scale: 2 }).notNull().default('0'),
  taxAmount: decimal('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  amountPaid: decimal('amount_paid', { precision: 15, scale: 2 }).notNull().default('0'),
  balanceDue: decimal('balance_due', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  /** Values for company-defined custom fields ({ [fieldName]: value }). */
  customFields: jsonb('custom_fields').$type<Record<string, string>>(),
  // wave2 sales: shipping fields (B6) + print/email queue flags (C7)
  shipDate: timestamp('ship_date'),
  shipVia: varchar('ship_via', { length: 100 }),
  fob: varchar('fob', { length: 100 }),
  trackingNumber: varchar('tracking_number', { length: 100 }),
  shipTo: jsonb('ship_to').$type<Record<string, string>>(),
  poNumber: varchar('po_number', { length: 100 }),
  toBePrinted: boolean('to_be_printed').notNull().default(false),
  toBeEmailed: boolean('to_be_emailed').notNull().default(false),
  lastEmailedAt: timestamp('last_emailed_at'),
  /** wave2 sales (C5): a customer-register statement charge (single line, appears on statements/aging). */
  isStatementCharge: boolean('is_statement_charge').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').references(() => invoices.id).notNull(),
  itemId: uuid('item_id').references(() => items.id),
  accountId: uuid('account_id').references(() => accounts.id), // income account
  description: text('description'),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
  rate: decimal('rate', { precision: 15, scale: 4 }).notNull().default('0'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  taxable: boolean('taxable').notNull().default(true),
  classId: uuid('class_id').references(() => classes.id),
  jobId: uuid('job_id').references(() => jobs.id),
  taxRateId: uuid('tax_rate_id').references(() => taxRates.id), // per-line tax override
  lineOrder: integer('line_order').notNull().default(0),
  /** Advanced pricing: which price rule/level priced this line (lib/services/pricing.ts). */
  pricing: jsonb('pricing').$type<Record<string, unknown>>(),
  /** fix/sales (0036): the estimate line this line bills (progress invoicing / conversion). */
  estimateLineId: uuid('estimate_line_id'),
  /** r5 sales (0064): the billable cost / time this line bills (released when an edit drops it). */
  billableSource: jsonb('billable_source').$type<{ kind: 'bill_line' | 'expense_line' | 'time_entry'; id: string }>(),
});

// ---- Payments received (A/R) ----
export const paymentsReceived = pgTable('payments_received', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  date: timestamp('date').notNull(),
  method: paymentMethodEnum('method').notNull().default('check'),
  reference: varchar('reference', { length: 100 }),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  unapplied: decimal('unapplied', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Payment currency + rate to base — needed to clear A/R on foreign-currency invoices. */
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 15, scale: 6 }),
  depositAccountId: uuid('deposit_account_id').references(() => accounts.id), // bank or undeposited funds
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  voidedAt: timestamp('voided_at'),
  /** wave2 sales: account early-payment discounts are posted to (C3). */
  discountAccountId: uuid('discount_account_id'),
  memo: text('memo'),
  /** wave2 sales: set when the check bounced (F2, see bounced_checks). */
  bouncedAt: timestamp('bounced_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Sales receipts (paid-at-point-of-sale; posts income + payment in one step) ----
export const salesReceipts = pgTable('sales_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  customerId: uuid('customer_id').references(() => customers.id),
  receiptNumber: integer('receipt_number').notNull(),
  /** Alphanumeric document number shown to users (e.g. "INV-1001"); see lib/services/docNumbers.ts. */
  refNumber: varchar('ref_number', { length: 50 }),
  date: timestamp('date').notNull(),
  /** Receipt-level sales tax rate (wave2 accountant: sales-tax liability attribution). */
  taxRateId: uuid('tax_rate_id').references(() => taxRates.id),
  method: paymentMethodEnum('method').notNull().default('cash'),
  reference: varchar('reference', { length: 100 }),
  status: docStatusEnum('status').notNull().default('paid'),
  classId: uuid('class_id').references(() => classes.id),
  subtotal: decimal('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
  taxAmount: decimal('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  depositAccountId: uuid('deposit_account_id').references(() => accounts.id), // bank or undeposited funds
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  // wave2 sales: shipping fields (B6) + print/email queue flags (C7)
  shipDate: timestamp('ship_date'),
  shipVia: varchar('ship_via', { length: 100 }),
  fob: varchar('fob', { length: 100 }),
  trackingNumber: varchar('tracking_number', { length: 100 }),
  shipTo: jsonb('ship_to').$type<Record<string, string>>(),
  poNumber: varchar('po_number', { length: 100 }),
  toBePrinted: boolean('to_be_printed').notNull().default(false),
  toBeEmailed: boolean('to_be_emailed').notNull().default(false),
  lastEmailedAt: timestamp('last_emailed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const salesReceiptLines = pgTable('sales_receipt_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  salesReceiptId: uuid('sales_receipt_id').references(() => salesReceipts.id).notNull(),
  itemId: uuid('item_id').references(() => items.id),
  accountId: uuid('account_id').references(() => accounts.id), // income account
  description: text('description'),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
  rate: decimal('rate', { precision: 15, scale: 4 }).notNull().default('0'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  taxable: boolean('taxable').notNull().default(true),
  classId: uuid('class_id').references(() => classes.id),
  jobId: uuid('job_id').references(() => jobs.id),
  taxRateId: uuid('tax_rate_id').references(() => taxRates.id),
  lineOrder: integer('line_order').notNull().default(0),
  /** Advanced pricing: which price rule/level priced this line (lib/services/pricing.ts). */
  pricing: jsonb('pricing').$type<Record<string, unknown>>(),
});

export const paymentApplications = pgTable('payment_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').references(() => paymentsReceived.id).notNull(),
  invoiceId: uuid('invoice_id').references(() => invoices.id).notNull(),
  amountApplied: decimal('amount_applied', { precision: 15, scale: 2 }).notNull(),
  /** wave2 sales (C3): early-payment discount taken on this invoice (reduces its balance too). */
  discountAmount: decimal('discount_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  /** P1 payments: home-currency A/R relieved by this application, cash + discount (null = legacy, amount x rate). */
  amountHome: decimal('amount_home', { precision: 15, scale: 2 }),
});

// ---- Bills (A/P) ----
export const bills = pgTable('bills', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  billNumber: varchar('bill_number', { length: 100 }),
  date: timestamp('date').notNull(),
  dueDate: timestamp('due_date'),
  terms: varchar('terms', { length: 50 }),
  status: docStatusEnum('status').notNull().default('open'),
  classId: uuid('class_id').references(() => classes.id),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  amountPaid: decimal('amount_paid', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Portion of the bill settled by vendor credits (not cash) — kept separate from amountPaid. */
  amountCredited: decimal('amount_credited', { precision: 15, scale: 2 }).notNull().default('0'),
  balanceDue: decimal('balance_due', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  /** wave2 purchases: transaction currency (null = home) + home units per 1 transaction unit. */
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [index('bills_company_vendor_idx').on(t.companyId, t.vendorId)]);

export const billLines = pgTable('bill_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  billId: uuid('bill_id').references(() => bills.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  itemId: uuid('item_id').references(() => items.id),
  description: text('description'),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  classId: uuid('class_id').references(() => classes.id),
  customerId: uuid('customer_id').references(() => customers.id), // billable
  jobId: uuid('job_id').references(() => jobs.id),
  /** Set when this billable line has been pulled onto a customer invoice. */
  billedInvoiceId: uuid('billed_invoice_id').references(() => invoices.id),
  lineOrder: integer('line_order').notNull().default(0),
}, (t) => [index('bill_lines_bill_idx').on(t.billId)]);

// ---- Bill payments (A/P) ----
export const billPayments = pgTable('bill_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  date: timestamp('date').notNull(),
  method: paymentMethodEnum('method').notNull().default('check'),
  reference: varchar('reference', { length: 100 }),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  paymentAccountId: uuid('payment_account_id').references(() => accounts.id), // bank/CC
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  voidedAt: timestamp('voided_at'),
  /** wave2 purchases: bill-payment check queued for Print Checks (number stamped at print). */
  toPrint: boolean('to_print').notNull().default(false),
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('bill_payments_company_account_idx').on(t.companyId, t.paymentAccountId)]);

export const billPaymentApplications = pgTable('bill_payment_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  billPaymentId: uuid('bill_payment_id').references(() => billPayments.id).notNull(),
  billId: uuid('bill_id').references(() => bills.id).notNull(),
  amountApplied: decimal('amount_applied', { precision: 15, scale: 2 }).notNull(),
  /** wave2 purchases: home-currency A/P relieved by this application (null = amountApplied). */
  amountHome: decimal('amount_home', { precision: 15, scale: 2 }),
}, (t) => [index('bill_payment_applications_bill_idx').on(t.billId), index('bill_payment_applications_payment_idx').on(t.billPaymentId)]);

// ---- Direct expenses / checks (non-bill spend) ----
export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id),
  payeeName: varchar('payee_name', { length: 255 }),
  /** drizzle/0055 (B3): payee from the Other Names list (QB "Other" name); null = vendor / free text. */
  otherNameId: uuid('other_name_id').references((): any => otherNames.id),
  date: timestamp('date').notNull(),
  method: paymentMethodEnum('method').notNull().default('check'),
  reference: varchar('reference', { length: 100 }),
  paymentAccountId: uuid('payment_account_id').references(() => accounts.id).notNull(),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  /** 'check' expenses queue for check printing until printed (QB Write Checks → Print Queue). */
  toPrint: boolean('to_print').notNull().default(false),
  voidedAt: timestamp('voided_at'),
  /** wave2 purchases: transaction currency (null = home) + home units per 1 transaction unit. */
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [index('expenses_company_account_idx').on(t.companyId, t.paymentAccountId)]);

export const expenseLines = pgTable('expense_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  expenseId: uuid('expense_id').references(() => expenses.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  description: text('description'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  classId: uuid('class_id').references(() => classes.id),
  customerId: uuid('customer_id').references(() => customers.id),
  jobId: uuid('job_id').references(() => jobs.id),
  /** Set when this billable line has been pulled onto a customer invoice. */
  billedInvoiceId: uuid('billed_invoice_id').references(() => invoices.id),
  lineOrder: integer('line_order').notNull().default(0),
  /** wave2 purchases: Items tab on Write Checks / CC charges. */
  itemId: uuid('item_id').references(() => items.id),
  quantity: decimal('quantity', { precision: 15, scale: 4 }),
  unitCost: decimal('unit_cost', { precision: 15, scale: 4 }),
}, (t) => [index('expense_lines_expense_idx').on(t.expenseId)]);

// ---- Bank transfers ----
export const transfers = pgTable('transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  date: timestamp('date').notNull(),
  fromAccountId: uuid('from_account_id').references(() => accounts.id).notNull(),
  toAccountId: uuid('to_account_id').references(() => accounts.id).notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  /** wave2 purchases: transfers can be voided (reverses the entry). */
  voidedAt: timestamp('voided_at'),
  /** p1 fx (0043): `amount` is in the FROM account's currency (null = home); `toAmount` in the
   * TO account's currency; `homeAmount` is what both GL lines carry in home currency. */
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  toCurrency: varchar('to_currency', { length: 3 }),
  toAmount: decimal('to_amount', { precision: 15, scale: 2 }),
  homeAmount: decimal('home_amount', { precision: 15, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Bank feed staging + categorization rules ----
export const bankTransactions = pgTable('bank_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id).notNull(),
  fileImportId: uuid('file_import_id').references(() => fileImports.id),
  fitId: varchar('fit_id', { length: 255 }), // OFX FITID for dedupe
  date: timestamp('date').notNull(),
  description: text('description'),
  payee: varchar('payee', { length: 255 }),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  matched: boolean('matched').notNull().default(false),
  matchedEntryId: uuid('matched_entry_id').references(() => journalEntries.id),
  /** User excluded this feed line from review (duplicate/personal) — QB "Exclude". */
  excluded: boolean('excluded').notNull().default(false),
  suggestedAccountId: uuid('suggested_account_id').references(() => accounts.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const transactionRules = pgTable('transaction_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  matchField: varchar('match_field', { length: 50 }).notNull().default('description'),
  matchOperator: varchar('match_operator', { length: 50 }).notNull().default('contains'),
  matchValue: varchar('match_value', { length: 255 }).notNull(),
  setAccountId: uuid('set_account_id').references(() => accounts.id),
  setPayee: varchar('set_payee', { length: 255 }),
  priority: integer('priority').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // ---- bankrules (0048): conditions, actions, mode, learning + usage ----
  /** Only fire for this bank account (null = any). */
  bankAccountId: uuid('bank_account_id'),
  /** 'any' | 'in' (money in) | 'out' (money out). */
  direction: varchar('direction', { length: 10 }).notNull().default('any'),
  /** Absolute-amount range; min = max means "amount equals". */
  amountMin: decimal('amount_min', { precision: 15, scale: 2 }),
  amountMax: decimal('amount_max', { precision: 15, scale: 2 }),
  setClassId: uuid('set_class_id'),
  setMemo: varchar('set_memo', { length: 255 }),
  /** Optional split by percentage: [{ accountId, classId, percent }] summing to 100. */
  splits: jsonb('splits').$type<{ accountId: string; classId?: string | null; percent: string }[]>(),
  /** 'suggest' (pre-fill for review) | 'auto' (post automatically). */
  mode: varchar('mode', { length: 10 }).notNull().default('suggest'),
  enabled: boolean('enabled').notNull().default(true),
  learned: boolean('learned').notNull().default(false),
  appliedCount: integer('applied_count').notNull().default(0),
  lastAppliedAt: timestamp('last_applied_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** bankrules (0048): every bank-feed line categorized, keyed by its normalized description. */
export const bankCategorizationHistory = pgTable('bank_categorization_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  bankTransactionId: uuid('bank_transaction_id').notNull(),
  bankAccountId: uuid('bank_account_id').notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  pattern: varchar('pattern', { length: 255 }).notNull(),
  direction: varchar('direction', { length: 10 }).notNull(),
  accountId: uuid('account_id').notNull(),
  classId: uuid('class_id'),
  payee: varchar('payee', { length: 255 }),
  split: boolean('split').notNull().default(false),
  /** 'user' | 'bulk' | 'rule' | 'rule_auto' | 'ai' */
  source: varchar('source', { length: 20 }).notNull().default('user'),
  ruleId: uuid('rule_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** bankrules (0048): "don't offer a rule for this pattern → account again". */
export const bankRuleDismissals = pgTable('bank_rule_dismissals', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  pattern: varchar('pattern', { length: 255 }).notNull(),
  /** 'in' (money in) | 'out' (money out) — a money-out "No thanks" never hides a money-in offer. */
  direction: varchar('direction', { length: 10 }).notNull(),
  accountId: uuid('account_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Payroll ----
export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  email: varchar('email', { length: 255 }),
  payType: payTypeEnum('pay_type').notNull().default('hourly'),
  payRate: decimal('pay_rate', { precision: 15, scale: 2 }).notNull().default('0'),
  ssn: text('ssn'), // encrypted at rest
  portalPasswordHash: text('portal_password_hash'), // employee self-service login
  w4: jsonb('w4').$type<Record<string, unknown>>(),
  /** Mailing address for W-2/pay stubs: { line1, line2, city, state, zip }. */
  address: jsonb('address').$type<Record<string, unknown>>(),
  /** Sick/vacation accrual policy + running balances (hours). */
  accruals: jsonb('accruals').$type<Record<string, unknown>>(),
  /** Wave-2 lists: billing rate level used when this employee's time is billed. */
  billingRateLevelId: uuid('billing_rate_level_id').references((): any => billingRateLevels.id),
  /** wave2 payroll: employment dates, phone and default workers-comp class code. */
  hireDate: timestamp('hire_date'),
  releaseDate: timestamp('release_date'),
  phone: varchar('phone', { length: 50 }),
  workersCompCodeId: uuid('workers_comp_code_id'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const paychecks = pgTable('paychecks', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  employeeId: uuid('employee_id').references(() => employees.id).notNull(),
  payDate: timestamp('pay_date').notNull(),
  periodStart: timestamp('period_start'),
  periodEnd: timestamp('period_end'),
  grossPay: decimal('gross_pay', { precision: 15, scale: 2 }).notNull().default('0'),
  totalTaxes: decimal('total_taxes', { precision: 15, scale: 2 }).notNull().default('0'),
  totalDeductions: decimal('total_deductions', { precision: 15, scale: 2 }).notNull().default('0'),
  netPay: decimal('net_pay', { precision: 15, scale: 2 }).notNull().default('0'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  /** Batch pay run this paycheck was created in (optional). */
  payRunId: uuid('pay_run_id').references(() => payRuns.id),
  /**
   * wave2 payroll: 'paycheck' (a real check), 'ytd_adjustment' (historical YTD amounts entered
   * at mid-year setup) or 'liability_adjustment' (Adjust Payroll Liabilities). Adjustments may
   * be non-posting (postedEntryId null) — they still count in W-2/941/940/YTD.
   */
  entryType: varchar('entry_type', { length: 30 }).notNull().default('paycheck'),
  memo: text('memo'),
  voidedAt: timestamp('voided_at'),
  /**
   * Review round 5 (0068): pay periods per year the withholding was calculated with (52, 26,
   * 24, 12 ...). Edit Paycheck recalculates with it; NULL (older rows, adjustments) = the
   * company's payroll pay period preference.
   */
  periodsPerYear: integer('periods_per_year'),
  /** wave2 purchases: paycheck queued for Print Checks; number stamped when printed. */
  toPrint: boolean('to_print').notNull().default(false),
  checkNumber: varchar('check_number', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const paycheckLines = pgTable('paycheck_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  paycheckId: uuid('paycheck_id').references(() => paychecks.id).notNull(),
  kind: varchar('kind', { length: 50 }).notNull(), // earning|tax|deduction|employer_contribution
  name: varchar('name', { length: 255 }).notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Optional link to a payroll item definition (GL mapping + pre/post-tax behavior). */
  payrollItemId: uuid('payroll_item_id').references(() => payrollItems.id),
  /** Tax tracking type (lib/services/payrollTaxTracking.ts) — drives W-2/941/940 aggregation. */
  taxTracking: varchar('tax_tracking', { length: 40 }),
});

/** Payroll item definitions — QB-style earnings/taxes/deductions with GL mapping. */
export const payrollItems = pgTable('payroll_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  /** earning | tax | deduction | employer_contribution | garnishment */
  kind: varchar('kind', { length: 50 }).notNull(),
  /** Deductions: pre-tax reduces taxable wages; post-tax does not. */
  pretax: boolean('pretax').notNull().default(false),
  /** QB "tax tracking type": 401k, section125, federal_withholding, futa, ... (payrollTaxTracking.ts). */
  taxTracking: varchar('tax_tracking', { length: 40 }),
  /** GL: expense side (earnings/employer items) and/or liability side (taxes/deductions). */
  expenseAccountId: uuid('expense_account_id').references(() => accounts.id),
  liabilityAccountId: uuid('liability_account_id').references(() => accounts.id),
  /** Optional default: 'fixed' amount or 'percent' of gross. */
  calcBasis: varchar('calc_basis', { length: 20 }),
  defaultRate: decimal('default_rate', { precision: 15, scale: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Batch pay runs grouping paychecks entered together. */
export const payRuns = pgTable('pay_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  payDate: timestamp('pay_date').notNull(),
  periodStart: timestamp('period_start'),
  periodEnd: timestamp('period_end'),
  memo: text('memo'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Budgets ----
export const budgets = pgTable('budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  fiscalYear: integer('fiscal_year').notNull(),
  /** wave2 reports: 'profit_loss' (income/expense) or 'balance_sheet' (month-end balances). */
  kind: varchar('kind', { length: 20 }).notNull().default('profit_loss'),
  /** wave2 reports: QB Forecast (same shape as a budget, reported separately). */
  isForecast: boolean('is_forecast').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const budgetLines = pgTable('budget_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  budgetId: uuid('budget_id').references(() => budgets.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  classId: uuid('class_id').references(() => classes.id), // optional class dimension
  /** wave2 reports: optional Customer:Job dimension (QB budgets by Customer:Job). */
  customerId: uuid('customer_id').references(() => customers.id),
  month: integer('month').notNull(), // 1-12
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
});

// ---- Recurring / memorized templates ----
export const recurringTemplates = pgTable('recurring_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  docType: varchar('doc_type', { length: 50 }).notNull(), // invoice|bill|journal_entry
  frequency: varchar('frequency', { length: 50 }).notNull().default('monthly'),
  nextRunDate: timestamp('next_run_date'),
  template: jsonb('template').$type<Record<string, unknown>>().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // wave2 prefs (QB Memorized Transaction List depth): group, how often to remind,
  // number remaining, days in advance to enter, last time it was entered.
  groupName: varchar('group_name', { length: 100 }),
  /** 'automatic' (enter on schedule) | 'remind' (Reminders list) | 'never' (manual only). */
  mode: varchar('mode', { length: 20 }).notNull().default('automatic'),
  /** Number of entries left; null = unlimited. Deactivates the template when it reaches 0. */
  remaining: integer('remaining'),
  /** Enter (or remind) this many days before the scheduled date. */
  daysInAdvance: integer('days_in_advance').notNull().default(0),
  lastRunAt: timestamp('last_run_at'),
  /** Twice-a-month schedules: the pair's first-half day (1-15), so 15th/30th survives February. */
  anchorDay: integer('anchor_day'),
});

// ---- Attachments / document store ----
export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Null (with entityId) = unfiled: sitting in the Doc Center inbox (wave2 prefs). */
  entityType: varchar('entity_type', { length: 100 }),
  entityId: uuid('entity_id'),
  filename: varchar('filename', { length: 255 }).notNull(),
  storagePath: text('storage_path').notNull(),
  mimeType: varchar('mime_type', { length: 100 }),
  sizeBytes: integer('size_bytes'),
  /** Doc Center description / keywords (wave2 prefs). */
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Fiscal periods / close ----
export const fiscalPeriods = pgTable('fiscal_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  isClosed: boolean('is_closed').notNull().default(false),
  closedAt: timestamp('closed_at'),
  closedBy: uuid('closed_by').references(() => users.id),
});

// ---- Credit memos (A/R credits) ----
export const creditMemos = pgTable('credit_memos', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  memoNumber: integer('memo_number').notNull(),
  /** Alphanumeric document number shown to users (e.g. "INV-1001"); see lib/services/docNumbers.ts. */
  refNumber: varchar('ref_number', { length: 50 }),
  date: timestamp('date').notNull(),
  /** Memo-level sales tax rate (wave2 accountant: lets the sales-tax liability engine attribute
   *  credited-back tax to the right agency). Null on legacy memos. */
  taxRateId: uuid('tax_rate_id').references(() => taxRates.id),
  status: docStatusEnum('status').notNull().default('open'),
  subtotal: decimal('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
  taxAmount: decimal('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  unapplied: decimal('unapplied', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Portion refunded by check (reduces unapplied). */
  refundedAmount: decimal('refunded_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  toBePrinted: boolean('to_be_printed').notNull().default(false),
  toBeEmailed: boolean('to_be_emailed').notNull().default(false),
  lastEmailedAt: timestamp('last_emailed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const creditMemoLines = pgTable('credit_memo_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  creditMemoId: uuid('credit_memo_id').references(() => creditMemos.id).notNull(),
  itemId: uuid('item_id').references(() => items.id),
  accountId: uuid('account_id').references(() => accounts.id),
  description: text('description'),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
  rate: decimal('rate', { precision: 15, scale: 4 }).notNull().default('0'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  lineOrder: integer('line_order').notNull().default(0),
  /** wave2 sales: persisted so an edit recomputes tax / restocking exactly. */
  taxable: boolean('taxable').notNull().default(true),
  restock: boolean('restock').notNull().default(true),
  /** drizzle/0055 (B12): which price rule/level priced this line (lib/services/pricing.ts). */
  pricing: jsonb('pricing').$type<Record<string, unknown>>(),
});

// ---- Vendor credits (A/P credits) ----
export const vendorCredits = pgTable('vendor_credits', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  date: timestamp('date').notNull(),
  status: docStatusEnum('status').notNull().default('open'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  unapplied: decimal('unapplied', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Portion refunded by check (reduces unapplied). */
  refundedAmount: decimal('refunded_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  /** p1 purchases: the vendor's credit memo number (QB "Ref. No."). */
  refNumber: varchar('ref_number', { length: 50 }),
  /** p1 fx (0043): credit currency (null = home), home units per 1 unit, home A/P debited and
   * the home part of it still unapplied (total/unapplied above stay in the credit's currency). */
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  homeTotal: decimal('home_total', { precision: 15, scale: 2 }),
  homeUnapplied: decimal('home_unapplied', { precision: 15, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const vendorCreditLines = pgTable('vendor_credit_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  vendorCreditId: uuid('vendor_credit_id').references(() => vendorCredits.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  description: text('description'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  lineOrder: integer('line_order').notNull().default(0),
  /** p1 purchases: Items tab (returned items), Class and Customer:Job. */
  itemId: uuid('item_id').references(() => items.id),
  quantity: decimal('quantity', { precision: 15, scale: 4 }),
  unitCost: decimal('unit_cost', { precision: 15, scale: 4 }),
  /** Inventory returns: the stock's cost taken out of inventory (home currency). */
  costAmount: decimal('cost_amount', { precision: 15, scale: 2 }),
  classId: uuid('class_id').references(() => classes.id),
  customerId: uuid('customer_id').references(() => customers.id),
  jobId: uuid('job_id').references((): any => jobs.id),
}, (t) => [index('vendor_credit_lines_credit_idx').on(t.vendorCreditId)]);

// ---- Sales orders (convert to invoice) ----
export const salesOrders = pgTable('sales_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  orderNumber: integer('order_number').notNull(),
  /** Alphanumeric document number shown to users (e.g. "INV-1001"); see lib/services/docNumbers.ts. */
  refNumber: varchar('ref_number', { length: 50 }),
  date: timestamp('date').notNull(),
  status: docStatusEnum('status').notNull().default('open'),
  subtotal: decimal('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  convertedInvoiceId: uuid('converted_invoice_id'),
  /** p1/salesforms: sales tax on sales orders (drizzle/0040). */
  taxRateId: uuid('tax_rate_id'),
  taxAmount: decimal('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  // wave2 sales: shipping fields (B6) + print/email queue flags (C7)
  shipDate: timestamp('ship_date'),
  shipVia: varchar('ship_via', { length: 100 }),
  fob: varchar('fob', { length: 100 }),
  trackingNumber: varchar('tracking_number', { length: 100 }),
  shipTo: jsonb('ship_to').$type<Record<string, string>>(),
  poNumber: varchar('po_number', { length: 100 }),
  toBePrinted: boolean('to_be_printed').notNull().default(false),
  toBeEmailed: boolean('to_be_emailed').notNull().default(false),
  lastEmailedAt: timestamp('last_emailed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const salesOrderLines = pgTable('sales_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  salesOrderId: uuid('sales_order_id').references(() => salesOrders.id).notNull(),
  itemId: uuid('item_id').references(() => items.id),
  description: text('description'),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
  rate: decimal('rate', { precision: 15, scale: 4 }).notNull().default('0'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Quantity already pulled onto invoices — enables partial invoicing/backorders. */
  quantityInvoiced: decimal('quantity_invoiced', { precision: 15, scale: 4 }).notNull().default('0'),
  lineOrder: integer('line_order').notNull().default(0),
  /** Advanced pricing: which price rule/level priced this line (lib/services/pricing.ts). */
  pricing: jsonb('pricing').$type<Record<string, unknown>>(),
  /** p1/salesforms: QB "Tax" column (drizzle/0040). */
  taxable: boolean('taxable').notNull().default(true),
});

// ---- Jobs / Projects (job costing) ----
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull().default('active'),
  budget: decimal('budget', { precision: 15, scale: 2 }),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  isActive: boolean('is_active').notNull().default(true),
  /** Wave-2 lists: Job Type list. */
  jobTypeId: uuid('job_type_id').references((): any => jobTypes.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Inventory cost layers (FIFO) ----
export const inventoryLayers = pgTable('inventory_layers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  date: timestamp('date').notNull(),
  quantityRemaining: decimal('quantity_remaining', { precision: 15, scale: 4 }).notNull(),
  unitCost: decimal('unit_cost', { precision: 15, scale: 4 }).notNull(),
  /** Originating document (e.g. "item_receipt:<id>") — lets landed cost find the receipt's layers. */
  sourceRef: varchar('source_ref', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Customer-specific pricing (price levels) ----
export const customerPrices = pgTable('customer_prices', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  price: decimal('price', { precision: 15, scale: 4 }).notNull(),
});

// ---- Employee expense reports / reimbursements ----
export const expenseReports = pgTable('expense_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  employeeId: uuid('employee_id').references(() => employees.id).notNull(),
  title: varchar('title', { length: 255 }),
  status: varchar('status', { length: 50 }).notNull().default('draft'), // draft|submitted|approved|reimbursed|rejected
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  submittedAt: timestamp('submitted_at'),
  approvedBy: uuid('approved_by').references(() => users.id),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const expenseReportLines = pgTable('expense_report_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  expenseReportId: uuid('expense_report_id').references(() => expenseReports.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  date: timestamp('date'),
  description: text('description'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  lineOrder: integer('line_order').notNull().default(0),
});

// ---- Purchase Orders (PO -> receive -> bill) ----
export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  poNumber: integer('po_number').notNull(),
  /** Alphanumeric document number shown to users (e.g. "INV-1001"); see lib/services/docNumbers.ts. */
  refNumber: varchar('ref_number', { length: 50 }),
  date: timestamp('date').notNull(),
  expectedDate: timestamp('expected_date'),
  status: docStatusEnum('status').notNull().default('open'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  convertedBillId: uuid('converted_bill_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id).notNull(),
  itemId: uuid('item_id').references(() => items.id),
  accountId: uuid('account_id').references(() => accounts.id),
  description: text('description'),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
  rate: decimal('rate', { precision: 15, scale: 4 }).notNull().default('0'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Quantity already pulled onto bills — enables partial billing/receipt of a PO. */
  quantityBilled: decimal('quantity_billed', { precision: 15, scale: 4 }).notNull().default('0'),
  /**
   * Enhanced receiving: portion of quantityBilled that was RECEIVED on item receipts but has
   * not yet been vendor-billed (received = quantityBilled; billed = quantityBilled - this).
   */
  quantityReceivedUnbilled: decimal('quantity_received_unbilled', { precision: 15, scale: 4 })
    .notNull()
    .default('0'),
  lineOrder: integer('line_order').notNull().default(0),
}, (t) => [index('purchase_order_lines_po_idx').on(t.purchaseOrderId)]);

// ---- Item receipts (QB "Receive Items" before the bill arrives) ----
export const itemReceipts = pgTable('item_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id),
  date: timestamp('date').notNull(),
  reference: varchar('reference', { length: 100 }),
  /** open = awaiting bill; billed = converted to a bill; void. */
  status: varchar('status', { length: 20 }).notNull().default('open'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  convertedBillId: uuid('converted_bill_id').references(() => bills.id),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  voidedAt: timestamp('voided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const itemReceiptLines = pgTable('item_receipt_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemReceiptId: uuid('item_receipt_id').references(() => itemReceipts.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  description: text('description'),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
  unitCost: decimal('unit_cost', { precision: 15, scale: 4 }).notNull().default('0'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Enhanced receiving: quantity already vendor-billed (or written off) from this line. */
  quantityBilled: decimal('quantity_billed', { precision: 15, scale: 4 }).notNull().default('0'),
  lineOrder: integer('line_order').notNull().default(0),
}, (t) => [index('item_receipt_lines_receipt_idx').on(t.itemReceiptId)]);

// ---- Pending assembly builds (QB "Pending Builds") ----
export const pendingBuilds = pgTable('pending_builds', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  assemblyItemId: uuid('assembly_item_id').references(() => items.id).notNull(),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull(),
  date: timestamp('date').notNull(),
  memo: text('memo'),
  /** pending = waiting on components; built = finalized; cancelled. */
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Bank deposits (Undeposited Funds -> Make Deposit) ----
export const deposits = pgTable('deposits', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** Record-locking version (P1 controls, 0046; bumped by trigger bka_version_*). */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  depositAccountId: uuid('deposit_account_id').references(() => accounts.id).notNull(),
  date: timestamp('date').notNull(),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  voidedAt: timestamp('voided_at'),
  /** p1 fx (0043): deposit currency = the bank account's (null = home); `total` stays in it. */
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  homeTotal: decimal('home_total', { precision: 15, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const depositLines = pgTable('deposit_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  depositId: uuid('deposit_id').references(() => deposits.id).notNull(),
  paymentId: uuid('payment_id').references(() => paymentsReceived.id),
  description: text('description'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Account an "extra" (non-payment) deposit line credits (0037; null on payment/receipt lines). */
  accountId: uuid('account_id').references(() => accounts.id),
});

// ---- Multi-currency: currencies & exchange rates (relative to the company base currency) ----
export const currencies = pgTable('currencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  code: varchar('code', { length: 3 }).notNull(), // ISO 4217, e.g. USD/EUR/GBP
  name: varchar('name', { length: 100 }).notNull(),
  rateToBase: decimal('rate_to_base', { precision: 18, scale: 8 }).notNull().default('1'),
  isBase: boolean('is_base').notNull().default(false),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ---- p1 fx (0043): foreign vendor-credit applications + Home Currency Adjustments ----
/** One application (or, with negative amounts, an unapply) of a foreign vendor credit to a bill. */
export const vendorCreditApplications = pgTable('vendor_credit_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  vendorCreditId: uuid('vendor_credit_id').references(() => vendorCredits.id).notNull(),
  billId: uuid('bill_id').references(() => bills.id).notNull(),
  date: timestamp('date').notNull(),
  /** Transaction-currency amount (negative = unapplied). */
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  /** Home A/P relieved on the bill (at the bill's rate) and taken from the credit (at its rate). */
  homeBill: decimal('home_bill', { precision: 15, scale: 2 }).notNull(),
  homeCredit: decimal('home_credit', { precision: 15, scale: 2 }).notNull(),
  fxEntryId: uuid('fx_entry_id').references(() => journalEntries.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** QB Home Currency Adjustment: revalue foreign balances as of a date at entered rates. */
export const homeCurrencyAdjustments = pgTable('home_currency_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  date: timestamp('date').notNull(),
  memo: text('memo'),
  rates: jsonb('rates').$type<Record<string, string>>().notNull(),
  detail: jsonb('detail').$type<unknown[]>().notNull(),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  entryId: uuid('entry_id').references(() => journalEntries.id, { onDelete: 'set null' }),
  reversalEntryId: uuid('reversal_entry_id').references(() => journalEntries.id, { onDelete: 'set null' }),
  voidedAt: timestamp('voided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * p1 fx (0043): home A/R relieved on a foreign-currency invoice by a received payment (receive,
 * apply later, or - negative - unapply). The home amount still open on the invoice is its own A/R
 * line minus these rows (fxSubledger.ts), so the last payment clears exactly what is left on A/R.
 * Rows are deleted when the payment is voided or edited (its entries are voided with it).
 */
export const paymentFxReliefs = pgTable('payment_fx_reliefs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  paymentId: uuid('payment_id').references(() => paymentsReceived.id).notNull(),
  invoiceId: uuid('invoice_id').references(() => invoices.id).notNull(),
  date: timestamp('date').notNull(),
  /** Invoice-currency amount (applied + discount; negative = unapplied). */
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  /** Home A/R relieved on the invoice (negative = put back). */
  homeAmount: decimal('home_amount', { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Sales reps & commissions ----
export const salesReps = pgTable('sales_reps', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  commissionRate: decimal('commission_rate', { precision: 6, scale: 4 }).notNull().default('0'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Mileage tracking (reimbursable) ----
export const mileageLogs = pgTable('mileage_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  employeeId: uuid('employee_id').references(() => employees.id),
  customerId: uuid('customer_id').references(() => customers.id),
  jobId: uuid('job_id').references(() => jobs.id),
  date: timestamp('date').notNull(),
  miles: decimal('miles', { precision: 12, scale: 2 }).notNull().default('0'),
  ratePerMile: decimal('rate_per_mile', { precision: 8, scale: 4 }).notNull().default('0.67'),
  purpose: text('purpose'),
  /** wave2 reports: vehicle driven (Mileage by Vehicle report). */
  vehicle: varchar('vehicle', { length: 100 }),
  billable: boolean('billable').notNull().default(false),
  /** Wave-2 lists: Vehicle list + optional odometer readings. */
  vehicleId: uuid('vehicle_id').references((): any => vehicles.id),
  odometerStart: decimal('odometer_start', { precision: 12, scale: 1 }),
  odometerEnd: decimal('odometer_end', { precision: 12, scale: 1 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Inventory assemblies (bill of materials) ----
export const assemblyComponents = pgTable('assembly_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  assemblyItemId: uuid('assembly_item_id').references(() => items.id).notNull(),
  componentItemId: uuid('component_item_id').references(() => items.id).notNull(),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull().default('1'),
});

// ---- Combined sales-tax rate components (a rate composed of multiple agency components) ----
export const taxRateComponents = pgTable('tax_rate_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  taxRateId: uuid('tax_rate_id').references(() => taxRates.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  agencyId: uuid('agency_id').references(() => taxAgencies.id),
  rate: decimal('rate', { precision: 9, scale: 6 }).notNull(),
});

// ---- Time tracking (internal; billable time -> invoice) ----
export const timeEntries = pgTable('time_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  employeeId: uuid('employee_id').references(() => employees.id),
  customerId: uuid('customer_id').references(() => customers.id),
  jobId: uuid('job_id').references(() => jobs.id),
  serviceItemId: uuid('service_item_id').references(() => items.id),
  date: timestamp('date').notNull(),
  hours: decimal('hours', { precision: 10, scale: 2 }).notNull().default('0'),
  billable: boolean('billable').notNull().default(true),
  rate: decimal('rate', { precision: 15, scale: 2 }),
  description: text('description'),
  invoicedInvoiceId: uuid('invoiced_invoice_id').references((): any => invoices.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Fixed assets + depreciation ----
export const fixedAssets = pgTable('fixed_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  assetAccountId: uuid('asset_account_id').references(() => accounts.id),
  depreciationExpenseAccountId: uuid('depreciation_expense_account_id').references(() => accounts.id),
  accumulatedDepreciationAccountId: uuid('accumulated_depreciation_account_id').references(() => accounts.id),
  cost: decimal('cost', { precision: 15, scale: 2 }).notNull().default('0'),
  salvageValue: decimal('salvage_value', { precision: 15, scale: 2 }).notNull().default('0'),
  usefulLifeMonths: integer('useful_life_months').notNull().default(60),
  method: varchar('method', { length: 30 }).notNull().default('straight_line'),
  placedInService: timestamp('placed_in_service').notNull(),
  accumulatedDepreciation: decimal('accumulated_depreciation', { precision: 15, scale: 2 }).notNull().default('0'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const depreciationEntries = pgTable('depreciation_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  fixedAssetId: uuid('fixed_asset_id').references(() => fixedAssets.id).notNull(),
  date: timestamp('date').notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Memorized (saved) reports ----
export const memorizedReports = pgTable('memorized_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  reportType: varchar('report_type', { length: 100 }).notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  /** wave2 reports: Memorized Report Group this report belongs to (null = ungrouped). */
  groupId: uuid('group_id').references((): any => memorizedReportGroups.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// ---- team companyfile ----
// Anchor for the running transaction log (transactions.bktlg). Holds the log's genesis record
// and the latest sequence head the database knows about, so deleting, replacing or truncating
// the log file is detectable by verifyTransactionLog. Singleton row (id = 'log').
export const transactionLogAnchor = pgTable('transaction_log_anchor', {
  id: varchar('id', { length: 16 }).primaryKey().default('log'),
  genesisHash: varchar('genesis_hash', { length: 64 }).notNull(),
  genesisTs: varchar('genesis_ts', { length: 40 }).notNull(),
  headSeq: integer('head_seq').notNull(),
  headHash: varchar('head_hash', { length: 64 }).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ---- team hosting ----
// Multi-user hosting (QB Enterprise "multi-user mode" parity). These are housekeeping tables
// for the company FILE (not per-company business data), so they carry no FKs: a session row
// must never block deleting/merging a user, and restore swaps the whole file anyway.

/** One row per sign-in. The session id is embedded (signed) in the bka_session cookie. */
export const userSessions = pgTable('user_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  companyId: uuid('company_id'),
  /** Client address as seen by the multi-user host proxy ('local' for this machine). */
  remoteAddr: varchar('remote_addr', { length: 100 }),
  userAgent: text('user_agent'),
  /** True when the session arrived over the network through the multi-user host. */
  viaHost: boolean('via_host').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
  /** 'logout' | 'signed_out_by_admin' | 'expired' | 'password_reset' | 'password_changed' */
  endReason: varchar('end_reason', { length: 50 }),
});

/**
 * Single-user mode holder: at most one row per company (id = the company id). While set, every
 * other session working in that company is refused so admin utilities (condense, restore,
 * rebuild, import) can run exclusively.
 */
export const singleUserMode = pgTable('single_user_mode', {
  id: varchar('id', { length: 40 }).primaryKey(),
  sessionId: uuid('session_id').notNull(),
  userId: uuid('user_id').notNull(),
  enabledAt: timestamp('enabled_at').defaultNow().notNull(),
});

// ---- team users ----
// Enterprise roles & permissions (lib/permissions/model.ts). Built-in roles are defined in code;
// only CUSTOM roles are stored here. permissions = { [area]: ('view'|'create'|'modify'|'delete'|
// 'print'|'full')[] }, flags = { sensitivePayroll?, fullAccountNumbers?, closedPeriod? }.
export const companyRoles = pgTable('company_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  permissions: jsonb('permissions').$type<Record<string, string[]>>().notNull(),
  flags: jsonb('flags').$type<Record<string, boolean>>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// A user's roles in a company (union = effective permissions). role_key is a built-in role key
// ('admin', 'bookkeeper', …) or a company_roles.id. The SQL migration declares
// PRIMARY KEY (company_id, user_id, role_key).
export const userRoleAssignments = pgTable('user_role_assignments', {
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  roleKey: varchar('role_key', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- team ai ----
// AI layer: per-company provider/routing settings, the learned (local, pure-TS) categorizer
// model, an auditable log of AI auto-applied bank categorizations, and assistant write
// proposals awaiting human approval. See lib/ai/* and lib/services/ai*.ts.

/** Per-company AI settings. API keys inside `providers` are AES-GCM ciphertext (lib/ai/keyVault). */
export const aiSettings = pgTable('ai_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull().unique(),
  /** StoredProviderConfig[] (lib/ai/types.ts) — apiKeyEnc is ciphertext, never plaintext. */
  providers: jsonb('providers').$type<Record<string, unknown>[]>().notNull().default([]),
  /** Record<AiTask, RoutingPolicy>; missing tasks default to 'local-only'. */
  taskPolicies: jsonb('task_policies').$type<Record<string, string>>().notNull().default({}),
  /** Company opt-in for ANY cloud model call. Off by default (local-first). */
  cloudEnabled: boolean('cloud_enabled').notNull().default(false),
  autoApplyEnabled: boolean('auto_apply_enabled').notNull().default(false),
  /** Learned-categorizer confidence (0..1) at/above which bank-feed lines may auto-post. */
  autoApplyThreshold: decimal('auto_apply_threshold', { precision: 5, scale: 4 }).notNull().default('0.9500'),
  /** Ask the LLM router for low-confidence categorization suggestions. */
  llmSuggestEnabled: boolean('llm_suggest_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Learned categorizer state (naive Bayes counts) — one row per company. */
export const aiCategorizerModels = pgTable('ai_categorizer_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull().unique(),
  version: integer('version').notNull().default(1),
  model: jsonb('model').$type<Record<string, unknown>>().notNull(),
  sampleCount: integer('sample_count').notNull().default(0),
  /** Incremental-sync watermark: source documents created after this are not yet learned. */
  watermark: timestamp('watermark'),
  trainedAt: timestamp('trained_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Every bank-feed line the AI auto-categorized (never fed back into training). */
export const aiAutoApplied = pgTable('ai_auto_applied', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  bankTransactionId: uuid('bank_transaction_id').references(() => bankTransactions.id).notNull(),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  confidence: decimal('confidence', { precision: 5, scale: 4 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Assistant-proposed writes. Nothing posts until a user approves (then via normal services). */
export const aiProposals = pgTable('ai_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  kind: varchar('kind', { length: 50 }).notNull(), // 'journal_entry'
  summary: text('summary').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending|approved|rejected|failed
  resultRef: varchar('result_ref', { length: 255 }),
  error: text('error'),
  decidedBy: uuid('decided_by').references(() => users.id),
  decidedAt: timestamp('decided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- team glimport ----
/**
 * One row per completed QuickBooks General Ledger migration (lib/services/qbGlImport.ts):
 * the source file, period, counts, and the account-by-account reconciliation proof that was
 * shown to the user — kept so the proof stays part of the record.
 */
export const qbGlImports = pgTable('qb_gl_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  periodStart: timestamp('period_start'),
  periodEnd: timestamp('period_end'),
  entriesPosted: integer('entries_posted').notNull().default(0),
  entriesSkipped: integer('entries_skipped').notNull().default(0),
  accountsCreated: integer('accounts_created').notNull().default(0),
  /** Total posted to 'QB Import Suspense' when the user accepted a variance (null = none). */
  varianceAmount: decimal('variance_amount', { precision: 15, scale: 2 }),
  proof: jsonb('proof').$type<Record<string, unknown>>().notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- team inventory ----
// Advanced Inventory (QB Desktop Enterprise parity): inventory sites, bins, serial/lot
// tracking, inventory transfers, per-site reorder points and landed cost.
//
// Quantity model (see lib/services/inventorySites.ts for the full rationale):
//  - items.quantityOnHand stays the company-wide total that every costing path maintains.
//  - inventory_movements is an append-only, site-tagged quantity ledger written by every
//    site-aware document (invoices, sales receipts, credit memos, bills, item receipts,
//    adjustments, builds, transfers). A non-default site's quantity is the sum of its
//    movements; the default site holds the remainder (total - other sites), so the sum of
//    site quantities ALWAYS equals quantityOnHand by construction.
//  - Bins, serial numbers and lots are always movement-derived.

export const inventorySites = pgTable('inventory_sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }),
  address: jsonb('address').$type<Record<string, string>>(),
  /** Exactly one active default site per company; un-sited lines land here. */
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const inventoryBins = pgTable('inventory_bins', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  siteId: uuid('site_id').references(() => inventorySites.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const inventoryMovements = pgTable('inventory_movements', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  siteId: uuid('site_id').references(() => inventorySites.id).notNull(),
  binId: uuid('bin_id').references(() => inventoryBins.id),
  /** Signed quantity: + into the site/bin, - out of it. Serial rows are always +/-1. */
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull(),
  serialNumber: varchar('serial_number', { length: 100 }),
  lotNumber: varchar('lot_number', { length: 100 }),
  date: timestamp('date').notNull(),
  /** invoice | sales_receipt | credit_memo | bill | item_receipt | adjustment | build | unbuild | transfer | site_rebalance */
  sourceType: varchar('source_type', { length: 40 }).notNull(),
  sourceId: uuid('source_id'),
  /** Line index on the source document (lineOrder). */
  sourceLine: integer('source_line'),
  /** Set on a reversing row: the movement it cancels. */
  reversalOfId: uuid('reversal_of_id'),
  /** Set on an original row once it has been reversed (void/edit). */
  reversedAt: timestamp('reversed_at'),
  memo: text('memo'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Site/bin/serial/lot captured per document line (kept for drafts and edits). */
export const inventoryLineDetails = pgTable('inventory_line_details', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  sourceType: varchar('source_type', { length: 40 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  lineOrder: integer('line_order').notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  siteId: uuid('site_id').references(() => inventorySites.id),
  binId: uuid('bin_id').references(() => inventoryBins.id),
  serialNumbers: jsonb('serial_numbers').$type<string[]>(),
  lotNumber: varchar('lot_number', { length: 100 }),
  lotExpiration: timestamp('lot_expiration'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Lot master: one row per (item, lot) carrying the expiration date. */
export const inventoryLots = pgTable('inventory_lots', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  lotNumber: varchar('lot_number', { length: 100 }).notNull(),
  expirationDate: timestamp('expiration_date'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Per-site item settings (QB Enterprise per-site reorder points). */
export const itemSiteSettings = pgTable('item_site_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  siteId: uuid('site_id').references(() => inventorySites.id).notNull(),
  reorderPoint: decimal('reorder_point', { precision: 15, scale: 4 }),
  /** Optional max / reorder-up-to level used for the suggested order quantity. */
  maxQuantity: decimal('max_quantity', { precision: 15, scale: 4 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Transfer Inventory between sites (quantity only; no GL impact). */
export const inventoryTransfers = pgTable('inventory_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  transferNumber: integer('transfer_number').notNull(),
  date: timestamp('date').notNull(),
  fromSiteId: uuid('from_site_id').references(() => inventorySites.id).notNull(),
  toSiteId: uuid('to_site_id').references(() => inventorySites.id).notNull(),
  /** posted | void */
  status: varchar('status', { length: 20 }).notNull().default('posted'),
  memo: text('memo'),
  voidedAt: timestamp('voided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const inventoryTransferLines = pgTable('inventory_transfer_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferId: uuid('transfer_id').references(() => inventoryTransfers.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull(),
  fromBinId: uuid('from_bin_id').references(() => inventoryBins.id),
  toBinId: uuid('to_bin_id').references(() => inventoryBins.id),
  serialNumbers: jsonb('serial_numbers').$type<string[]>(),
  lotNumber: varchar('lot_number', { length: 100 }),
  lineOrder: integer('line_order').notNull().default(0),
});

/** Landed cost: a bill charge line (freight/duty/...) allocated onto item receipt lines. */
export const landedCostAllocations = pgTable('landed_cost_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  billId: uuid('bill_id').references(() => bills.id).notNull(),
  /** Source charge line on the bill (no FK: bill lines are replaced on edit, which is blocked while allocated). */
  billLineId: uuid('bill_line_id').notNull(),
  /** The account the charge was expensed to — credited when the cost moves into inventory. */
  chargeAccountId: uuid('charge_account_id').references(() => accounts.id).notNull(),
  /** quantity | value | weight */
  method: varchar('method', { length: 20 }).notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  date: timestamp('date').notNull(),
  /** posted | void */
  status: varchar('status', { length: 20 }).notNull().default('posted'),
  memo: text('memo'),
  voidedAt: timestamp('voided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const landedCostAllocationLines = pgTable('landed_cost_allocation_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  allocationId: uuid('allocation_id').references(() => landedCostAllocations.id).notNull(),
  itemReceiptId: uuid('item_receipt_id').references(() => itemReceipts.id).notNull(),
  itemReceiptLineId: uuid('item_receipt_line_id').references(() => itemReceiptLines.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  /** Allocation basis for this line (qty, value or weight). */
  basis: decimal('basis', { precision: 15, scale: 4 }).notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  /** Portion capitalised into inventory (units still on hand). */
  inventoryAmount: decimal('inventory_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Portion expensed to COGS (units already sold). */
  cogsAmount: decimal('cogs_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Quantity still on hand when applied (FIFO: receipt layers; average: item QOH). */
  quantityAtAllocation: decimal('quantity_at_allocation', { precision: 15, scale: 4 }).notNull().default('0'),
  /** FIFO only: per-layer unit-cost increments applied, so a void can back them out exactly. */
  layerAdjustments: jsonb('layer_adjustments').$type<Array<{ layerId: string; quantity: string; unitCostDelta: string; splitFrom?: string }>>(),
  entryId: uuid('entry_id').references(() => journalEntries.id),
  lineOrder: integer('line_order').notNull().default(0),
});

// ---- team pricing ----
// Advanced Pricing (price levels, price rules, customer/vendor types) and Enhanced Receiving
// (bill-vs-receipt links carrying quantity/price variances). See lib/services/pricing.ts and
// lib/services/receiving.ts.

/** QB "Customer Type" list (used by price rules and reports). */
export const customerTypes = pgTable('customer_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  parentId: uuid('parent_id'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** QB "Vendor Type" list. */
export const vendorTypes = pgTable('vendor_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  parentId: uuid('parent_id'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Price levels: 'fixed_percent' (every item's base price +/- percent) or 'per_item'
 * (explicit per-item prices in price_level_items). Assigned via customers.priceLevelId.
 */
export const priceLevels = pgTable('price_levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 20 }).notNull().default('fixed_percent'),
  /** Signed percent for fixed_percent levels: -10 = 10% below base, 5 = 5% above. */
  percent: decimal('percent', { precision: 9, scale: 4 }).notNull().default('0'),
  /** null = use the company default rounding (advancedPricing.defaultRounding). */
  rounding: varchar('rounding', { length: 20 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const priceLevelItems = pgTable('price_level_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  priceLevelId: uuid('price_level_id').references(() => priceLevels.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  price: decimal('price', { precision: 15, scale: 4 }).notNull(),
});

/** QB Enterprise Advanced Pricing price rules (conditions + adjustment + quantity tiers). */
export const priceRules = pgTable('price_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  /** Lower number = higher priority (used when the conflict mode is 'priority'). */
  priority: integer('priority').notNull().default(100),
  conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull(),
  adjustment: jsonb('adjustment').$type<Record<string, unknown>>().notNull(),
  tiers: jsonb('tiers').$type<Array<Record<string, unknown>>>(),
  rounding: varchar('rounding', { length: 20 }),
  /** Inclusive YYYY-MM-DD bounds compared against the document date. */
  startDate: varchar('start_date', { length: 10 }),
  endDate: varchar('end_date', { length: 10 }),
  minQuantity: decimal('min_quantity', { precision: 15, scale: 4 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Enhanced receiving: one row per (bill, item-receipt line) billed or written off. Carries the
 * receipt cost, the vendor's billed cost, and how the price variance was posted so that voiding
 * the bill can unwind it exactly.
 */
export const itemReceiptBillLines = pgTable('item_receipt_bill_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  billId: uuid('bill_id').references(() => bills.id).notNull(),
  itemReceiptId: uuid('item_receipt_id').references(() => itemReceipts.id).notNull(),
  itemReceiptLineId: uuid('item_receipt_line_id').references(() => itemReceiptLines.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  /** Quantity billed (or written off, when writtenOff = true). */
  quantity: decimal('quantity', { precision: 15, scale: 4 }).notNull(),
  receiptUnitCost: decimal('receipt_unit_cost', { precision: 15, scale: 4 }).notNull(),
  billUnitCost: decimal('bill_unit_cost', { precision: 15, scale: 4 }).notNull(),
  /** quantity x receipt cost relieved from the 2050 accrual. */
  accrualAmount: decimal('accrual_amount', { precision: 15, scale: 2 }).notNull(),
  /** Amount owed to the vendor for this line (0 for a write-off). */
  billAmount: decimal('bill_amount', { precision: 15, scale: 2 }).notNull(),
  /** billAmount - accrualAmount (signed). */
  variance: decimal('variance', { precision: 15, scale: 2 }).notNull().default('0'),
  /** 'inventory' | 'ppv' | 'expense' | 'none' — where the variance was posted. */
  varianceMode: varchar('variance_mode', { length: 20 }).notNull().default('none'),
  /** Portion capitalized into on-hand inventory and portion expensed (COGS / PPV / expense). */
  inventoryVariance: decimal('inventory_variance', { precision: 15, scale: 2 }).notNull().default('0'),
  expensedVariance: decimal('expensed_variance', { precision: 15, scale: 2 }).notNull().default('0'),
  /** FIFO layer cost adjustments made for inventoryVariance ([{ layerId, quantity, unitDelta }]); average-cost items store [{ kind: 'average', onHand }] (stock the variance was spread over). */
  layerAdjustments: jsonb('layer_adjustments').$type<Array<Record<string, string>>>(),
  writtenOff: boolean('written_off').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- wave2 lists ----
// QB Desktop "Lists" parity: Other Names, Job Types, Terms, Ship Via, Payment Methods, Customer
// Messages, Sales Tax Codes, To Do, timestamped Notes, Billing Rate Levels, Vehicles, Unit of
// Measure sets. Master data only — none of these post to the GL. See lib/services/lists/*.

/** Records which built-in default entries were seeded for a company (id = companyId:listKey). */
export const listSeeds = pgTable('list_seeds', {
  id: varchar('id', { length: 120 }).primaryKey(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  listKey: varchar('list_key', { length: 50 }).notNull(),
  seededAt: timestamp('seeded_at').defaultNow().notNull(),
});

/** QB "Other Names" list: payees that are not customers, vendors or employees. */
export const otherNames = pgTable('other_names', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  address: jsonb('address').$type<Record<string, string>>(),
  accountNumber: varchar('account_number', { length: 100 }),
  notes: text('notes'),
  billingRateLevelId: uuid('billing_rate_level_id').references((): any => billingRateLevels.id),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** QB "Job Type" list (optionally hierarchical). */
export const jobTypes = pgTable('job_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  parentId: uuid('parent_id').references((): any => jobTypes.id),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * QB "Terms" list. 'standard' = due N days after the transaction, optional early-payment discount
 * within D days; 'date_driven' = due on a fixed day of the month (the next month when issued
 * within `dueNextMonthWithinDays` of it), optional discount when paid by a fixed day of the month.
 * `code` keeps compatibility with the legacy terms strings ('net_30', 'due_on_receipt', ...).
 */
export const paymentTerms = pgTable('payment_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  code: varchar('code', { length: 50 }),
  kind: varchar('kind', { length: 20 }).notNull().default('standard'),
  netDays: integer('net_days'),
  discountPercent: decimal('discount_percent', { precision: 7, scale: 4 }),
  discountDays: integer('discount_days'),
  dueDayOfMonth: integer('due_day_of_month'),
  dueNextMonthWithinDays: integer('due_next_month_within_days'),
  discountDayOfMonth: integer('discount_day_of_month'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** QB "Ship Via" list. */
export const shipViaMethods = pgTable('ship_via_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** QB "Payment Method" list: custom names, each mapped to the payment_method enum `type`. */
export const paymentMethods = pgTable('payment_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  type: paymentMethodEnum('type').notNull().default('other'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** QB "Customer Message" list (printed at the bottom of sales forms). */
export const customerMessages = pgTable('customer_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  message: varchar('message', { length: 500 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** QB "Sales Tax Code" list: 'Tax' / 'Non' plus custom codes, each taxable or not. */
export const salesTaxCodes = pgTable('sales_tax_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  code: varchar('code', { length: 3 }).notNull(),
  description: varchar('description', { length: 255 }),
  taxable: boolean('taxable').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * LEGACY (read-only since 0039): the old Lists > To Do store. Its rows were copied into `todos`
 * (same ids), which is now the only To Do list. Kept so no data is ever lost; nothing writes it.
 */
export const todoItems = pgTable('todo_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  details: text('details'),
  /** call | fax | email | meeting | appointment | task */
  type: varchar('type', { length: 20 }).notNull().default('task'),
  /** low | medium | high */
  priority: varchar('priority', { length: 10 }).notNull().default('medium'),
  /** open | done | inactive */
  status: varchar('status', { length: 10 }).notNull().default('open'),
  dueDate: timestamp('due_date'),
  entityType: varchar('entity_type', { length: 30 }),
  entityId: uuid('entity_id'),
  assignedUserId: uuid('assigned_user_id').references(() => users.id),
  createdBy: uuid('created_by').references(() => users.id),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Timestamped notes on customers, vendors, employees and other names (many per record). */
export const entityNotes = pgTable('entity_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** customer | vendor | employee | other_name */
  entityType: varchar('entity_type', { length: 30 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  noteDate: timestamp('note_date').defaultNow().notNull(),
  body: text('body').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * QB "Billing Rate Level" list (time billing). 'fixed_rate' = one hourly rate for every service
 * item; 'custom' = per-service-item rates in billing_rate_level_items (items not listed fall back
 * to the item's sales price).
 */
export const billingRateLevels = pgTable('billing_rate_levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 20 }).notNull().default('fixed_rate'),
  fixedRate: decimal('fixed_rate', { precision: 15, scale: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const billingRateLevelItems = pgTable('billing_rate_level_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  levelId: uuid('level_id').references(() => billingRateLevels.id).notNull(),
  itemId: uuid('item_id').references(() => items.id).notNull(),
  rate: decimal('rate', { precision: 15, scale: 4 }).notNull(),
});

/** QB "Vehicle" list (mileage tracking). */
export const vehicles = pgTable('vehicles', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: varchar('description', { length: 255 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Unit of Measure sets (QB "multiple U/M per item"): a base unit plus related units, each with
 * a conversion factor = how many BASE units one of it holds (Case of 12 → 12). Inventory
 * quantities are always kept in the base unit: line qty × factor.
 */
export const uomSets = pgTable('uom_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  /** count | length | weight | volume | area | time | other */
  kind: varchar('kind', { length: 20 }).notNull().default('count'),
  baseUnitName: varchar('base_unit_name', { length: 50 }).notNull(),
  baseUnitAbbrev: varchar('base_unit_abbrev', { length: 20 }).notNull(),
  defaultPurchaseUnit: varchar('default_purchase_unit', { length: 50 }),
  defaultSalesUnit: varchar('default_sales_unit', { length: 50 }),
  defaultShippingUnit: varchar('default_shipping_unit', { length: 50 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const uomSetUnits = pgTable('uom_set_units', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  setId: uuid('set_id').references(() => uomSets.id).notNull(),
  name: varchar('name', { length: 50 }).notNull(),
  abbrev: varchar('abbrev', { length: 20 }).notNull(),
  /** Base units per one of this unit (> 0). */
  factor: decimal('factor', { precision: 18, scale: 6 }).notNull(),
  lineOrder: integer('line_order').notNull().default(0),
});
// ---- wave2 sales ----
// Credits applied to invoices (credit memo -> invoice), optionally inside a Receive Payments
// transaction (paymentId), bounced (NSF) checks, and Collections Center notes.

/** One credit-memo application to an invoice. Deleted when the application is undone. */
export const creditApplications = pgTable('credit_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  creditMemoId: uuid('credit_memo_id').references(() => creditMemos.id).notNull(),
  invoiceId: uuid('invoice_id').references(() => invoices.id).notNull(),
  /** Set when the credit was applied as part of a received payment (undone if it is voided/edited). */
  paymentId: uuid('payment_id').references(() => paymentsReceived.id),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  date: timestamp('date').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Applications of named General Journal A/R / A/P lines (0037, QB invariant I11): a JE A/R debit
 * paid by a received payment ('payment'), a JE A/R credit applied to an invoice ('invoice_credit'),
 * a JE A/P credit paid by a bill payment ('bill_payment'), a JE A/P debit applied to a bill
 * ('bill_credit'). Posts no GL; see lib/services/journalApplications.ts.
 */
export const journalItemApplications = pgTable('journal_item_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  side: varchar('side', { length: 2 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull(),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id).notNull(),
  journalLineId: uuid('journal_line_id').references(() => journalEntryLines.id).notNull(),
  paymentId: uuid('payment_id').references(() => paymentsReceived.id),
  billPaymentId: uuid('bill_payment_id').references(() => billPayments.id),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  billId: uuid('bill_id').references(() => bills.id),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  date: timestamp('date').notNull(),
  /** P1 payments (0041): kind 'journal_offset' — the two rows (credit line + charge line) of one application. */
  pairId: uuid('pair_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Record Bounced Check (QB "Record Bounced Check"): one row per bounced customer payment. */
export const bouncedChecks = pgTable('bounced_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  paymentId: uuid('payment_id').references(() => paymentsReceived.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  date: timestamp('date').notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  bankAccountId: uuid('bank_account_id').references(() => accounts.id).notNull(),
  reversalEntryId: uuid('reversal_entry_id').references(() => journalEntries.id),
  bankFee: decimal('bank_fee', { precision: 15, scale: 2 }).notNull().default('0'),
  bankFeeAccountId: uuid('bank_fee_account_id').references(() => accounts.id),
  bankFeeEntryId: uuid('bank_fee_entry_id').references(() => journalEntries.id),
  customerFee: decimal('customer_fee', { precision: 15, scale: 2 }).notNull().default('0'),
  customerFeeInvoiceId: uuid('customer_fee_invoice_id').references(() => invoices.id),
  /** Snapshot of the payment's invoice applications that were reopened. */
  applications: jsonb('applications').$type<Array<Record<string, string>>>(),
  memo: text('memo'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Collections Center notes (per customer, optionally per invoice) with a follow-up date. */
export const collectionNotes = pgTable('collection_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  note: text('note').notNull(),
  followUpDate: timestamp('follow_up_date'),
  done: boolean('done').notNull().default(false),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- wave2 purchases ----

/** Check printer setup (QB Printer Setup -> Check/Paycheck): style + alignment offsets per company. */
export const checkPrintSettings = pgTable('check_print_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull().unique(),
  /** 'voucher' | 'standard' | 'wallet' */
  style: varchar('style', { length: 20 }).notNull().default('voucher'),
  /** Alignment nudges in inches (positive = right / up). */
  offsetX: decimal('offset_x', { precision: 6, scale: 3 }).notNull().default('0'),
  offsetY: decimal('offset_y', { precision: 6, scale: 3 }).notNull().default('0'),
  /** p1 purchases: 'preprinted' (print only the variable fields) | 'blank' (full check layout). */
  stock: varchar('stock', { length: 20 }).notNull().default('preprinted'),
  /** drizzle/0047: 'top' | 'middle' | 'bottom' — where the check sits on voucher / wallet stock. */
  checkPosition: varchar('check_position', { length: 10 }).notNull().default('top'),
  /** drizzle/0047: field-position overrides (lib/pdf/checkLayout CheckLayoutOverrides); null = QB defaults. */
  layout: jsonb('layout').$type<Record<string, Record<string, number | boolean>>>(),
  /** drizzle/0047: standard checks (3 per sheet) — unused checks left on the first sheet (1-3). */
  firstSheetRemaining: integer('first_sheet_remaining').notNull().default(3),
  /** drizzle/0047: 'letter' | 'legal'. */
  pageSize: varchar('page_size', { length: 10 }).notNull().default('letter'),
  /** drizzle/0047: height of one check in inches (2.75-3.67). */
  checkHeight: decimal('check_height', { precision: 5, scale: 3 }).notNull().default('3.5'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * p1 purchases: printable check documents for Sales Tax Payments ('sales_tax'), Pay Payroll
 * Liabilities ('payroll_liability') and customer refund checks ('customer_refund'). The journal
 * entry (postedEntryId) is the ledger record; this row carries payee, check number and the
 * "To be printed" flag so the payment sits in the Print Checks queue and the check register.
 */
export const paymentChecks = pgTable('payment_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  kind: varchar('kind', { length: 30 }).notNull(),
  agencyId: uuid('agency_id').references(() => taxAgencies.id),
  vendorId: uuid('vendor_id').references(() => vendors.id),
  customerId: uuid('customer_id').references(() => customers.id),
  payeeName: varchar('payee_name', { length: 255 }).notNull(),
  paymentAccountId: uuid('payment_account_id').references(() => accounts.id).notNull(),
  date: timestamp('date').notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  reference: varchar('reference', { length: 100 }),
  toPrint: boolean('to_print').notNull().default(false),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  voidedAt: timestamp('voided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Loan Manager: a loan tracked against a liability account. */
export const loans = pgTable('loans', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  lenderVendorId: uuid('lender_vendor_id').references(() => vendors.id),
  liabilityAccountId: uuid('liability_account_id').references(() => accounts.id).notNull(),
  interestAccountId: uuid('interest_account_id').references(() => accounts.id).notNull(),
  escrowAccountId: uuid('escrow_account_id').references(() => accounts.id),
  paymentAccountId: uuid('payment_account_id').references(() => accounts.id),
  originalAmount: decimal('original_amount', { precision: 15, scale: 2 }).notNull(),
  /** Annual interest rate in percent, e.g. 6.5 */
  annualRate: decimal('annual_rate', { precision: 9, scale: 6 }).notNull(),
  termMonths: integer('term_months').notNull(),
  paymentsPerYear: integer('payments_per_year').notNull().default(12),
  originDate: timestamp('origin_date').notNull(),
  firstPaymentDate: timestamp('first_payment_date').notNull(),
  /** Escrow added to every payment (taxes / insurance). */
  escrowAmount: decimal('escrow_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  /** p1 fx (0043): loan currency (null = home) and the rate the loan was booked at. */
  currency: varchar('currency', { length: 3 }),
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** One "Set up payment" from the Loan Manager - the check or bill that carries it. */
export const loanPayments = pgTable('loan_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  loanId: uuid('loan_id').references(() => loans.id).notNull(),
  paymentNumber: integer('payment_number').notNull(),
  date: timestamp('date').notNull(),
  principal: decimal('principal', { precision: 15, scale: 2 }).notNull(),
  interest: decimal('interest', { precision: 15, scale: 2 }).notNull(),
  escrow: decimal('escrow', { precision: 15, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull(),
  /** 'check' | 'bill' */
  kind: varchar('kind', { length: 10 }).notNull(),
  expenseId: uuid('expense_id').references(() => expenses.id),
  billId: uuid('bill_id').references(() => bills.id),
  /** p1 fx (0043): payment rate and the realized exchange gain/loss entry on the principal. */
  exchangeRate: decimal('exchange_rate', { precision: 18, scale: 8 }),
  fxEntryId: uuid('fx_entry_id').references(() => journalEntries.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
// ---- wave2 accountant ----
// Accountant tools (lib/services/accountant/*): sales-tax line attribution (Fix Incorrectly
// Recorded Sales Tax), Working Trial Balance notes, Review List Changes, Client Data Review.
// Unique keys are declared in drizzle/0029_wave2_accountant.sql.

/**
 * Attribution of a journal line on a sales-tax liability account that was NOT recorded through
 * Pay Sales Tax / a sales document (e.g. a check or journal entry that paid the agency). The
 * posted line itself is never modified; this row only tells the sales-tax liability engine
 * which agency (and as what kind of activity) the line belongs to. Unique per line.
 */
export const salesTaxLineLinks = pgTable('sales_tax_line_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  journalEntryLineId: uuid('journal_entry_line_id').references(() => journalEntryLines.id).notNull(),
  agencyId: uuid('agency_id').references(() => taxAgencies.id),
  /** 'payment' | 'adjustment' | 'collected' */
  kind: varchar('kind', { length: 20 }).notNull(),
  note: text('note'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Working Trial Balance: per-account workpaper reference + accountant notes for a period end. */
export const workingTbNotes = pgTable('working_tb_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  /** 'YYYY-MM-DD' period end the note belongs to. */
  periodEnd: varchar('period_end', { length: 10 }).notNull(),
  workpaperRef: varchar('workpaper_ref', { length: 100 }),
  note: text('note'),
  createdBy: uuid('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Review List Changes: an audit-log row (list change) the accountant marked as reviewed. */
export const listChangeReviews = pgTable('list_change_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  auditLogId: uuid('audit_log_id').references(() => auditLogs.id).notNull(),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at').defaultNow().notNull(),
});

/** Client Data Review: account balances captured at the end of a review (compared next time). */
export const clientReviewSnapshots = pgTable('client_review_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** 'YYYY-MM-DD' — the review period end the balances are as of. */
  asOf: varchar('as_of', { length: 10 }).notNull(),
  /** accountId -> natural balance (2dp string) as of `asOf`. */
  balances: jsonb('balances').$type<Record<string, string>>().notNull(),
  note: text('note'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Client Data Review: per-task status (QB lets the accountant mark each task done). */
export const clientReviewTasks = pgTable('client_review_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  taskKey: varchar('task_key', { length: 64 }).notNull(),
  /** 'not_started' | 'in_progress' | 'completed' */
  status: varchar('status', { length: 20 }).notNull().default('not_started'),
  note: text('note'),
  createdBy: uuid('created_by').references(() => users.id),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
// ---- wave2 reports ----
/** Memorized Report Groups (QB: Memorized Report List groups; Process Multiple Reports). */
export const memorizedReportGroups = pgTable('memorized_report_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Scheduled reports: run a memorized report (or a whole group) on a schedule and save the export
 * to a local folder. The desktop shell's timer calls POST /api/reports/schedules/run-due (alias of /api/report-schedules/run-due).
 */
export const reportSchedules = pgTable('report_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  memorizedReportId: uuid('memorized_report_id').references(() => memorizedReports.id),
  groupId: uuid('group_id').references(() => memorizedReportGroups.id),
  /** daily | weekly | monthly */
  frequency: varchar('frequency', { length: 20 }).notNull(),
  nextRunAt: timestamp('next_run_at').notNull(),
  /** Day of month a monthly schedule is anchored to (31 = month end), so Feb 28 doesn't drift later months. */
  anchorDay: integer('anchor_day'),
  /** csv | xlsx */
  format: varchar('format', { length: 10 }).notNull().default('csv'),
  /** Sub-folder (inside the company's report-export folder) the files are written to. */
  folder: varchar('folder', { length: 100 }),
  isActive: boolean('is_active').notNull().default(true),
  lastRunAt: timestamp('last_run_at'),
  lastStatus: varchar('last_status', { length: 20 }),
  lastMessage: text('last_message'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- wave2 prefs ----

/** "My Preferences": per-user preferences inside one company file (QB Preferences > My Preferences). */
export const userPreferences = pgTable('user_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  prefs: jsonb('prefs').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Form templates (QB "Templates" list + Layout Designer): one row per named template. */
export const formTemplates = pgTable('form_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** invoice | estimate | sales_receipt | credit_memo | sales_order | purchase_order | statement */
  formType: varchar('form_type', { length: 30 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  /** Layout: colors, font, title, header/footer text, field + column visibility and labels. */
  design: jsonb('design').$type<Record<string, unknown>>().notNull(),
  /** Logo image stored locally in the company file via the attachments store. */
  logoAttachmentId: uuid('logo_attachment_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** To-dos (QB To Do List / Lead Center tasks): calls, meetings, tasks, emails. */
export const todos = pgTable('todos', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  userId: uuid('user_id').references(() => users.id),
  title: varchar('title', { length: 255 }).notNull(),
  notes: text('notes'),
  /** call | meeting | task | email */
  kind: varchar('kind', { length: 20 }).notNull().default('task'),
  /** low | medium | high */
  priority: varchar('priority', { length: 10 }).notNull().default('medium'),
  /** 'YYYY-MM-DD' (calendar day, no time zone shift). */
  dueDate: varchar('due_date', { length: 10 }),
  dueTime: varchar('due_time', { length: 5 }),
  done: boolean('done').notNull().default(false),
  doneAt: timestamp('done_at'),
  /** Optional link: customer | vendor | employee | lead */
  entityType: varchar('entity_type', { length: 30 }),
  entityId: uuid('entity_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  // p1 ux (0039): the ONE To Do store — todo_items rows were copied in under the same ids.
  /** open | done | inactive (kept in step with `done`). */
  status: varchar('status', { length: 10 }).notNull().default('open'),
  assignedUserId: uuid('assigned_user_id').references(() => users.id),
  /** 'YYYY-MM-DD': show in Reminders from this day (null = by due date and Preferences). */
  remindOn: varchar('remind_on', { length: 10 }),
});

/** Lead Center: prospects tracked before they become customers. */
export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }),
  /** hot | warm | cold */
  status: varchar('status', { length: 10 }).notNull().default('warm'),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  website: varchar('website', { length: 255 }),
  address: jsonb('address').$type<Record<string, string>>(),
  /** [{ name, title, email, phone }] */
  contacts: jsonb('contacts').$type<Array<Record<string, string>>>(),
  notes: text('notes'),
  convertedCustomerId: uuid('converted_customer_id').references(() => customers.id),
  convertedAt: timestamp('converted_at'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Custom letter templates (QB "Prepare Letters with Envelopes"), listed beside the built-ins. */
export const letterTemplates = pgTable('letter_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** collection | customer | vendor | employee | lead | other */
  category: varchar('category', { length: 20 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ---- wave2 payroll ----
// Employer state payroll taxes (SUI employer rate + wage base, SDI employee rate + wage base)
// per company, state and calendar year; workers' compensation class codes (rate per $100 of
// wages). See lib/services/payrollAdjustments.ts.

export const payrollStateSettings = pgTable('payroll_state_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  state: varchar('state', { length: 2 }).notNull(),
  year: integer('year').notNull(),
  /** Employer state unemployment (SUI/SUTA) rate as a fraction, e.g. 0.034000 = 3.4%. */
  suiRate: decimal('sui_rate', { precision: 9, scale: 6 }).notNull().default('0'),
  /** SUI taxable wage base per employee per year (0 = no cap). */
  suiWageBase: decimal('sui_wage_base', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Employee state disability (SDI) withholding rate as a fraction (0 = none). */
  sdiRate: decimal('sdi_rate', { precision: 9, scale: 6 }).notNull().default('0'),
  /** SDI wage base per employee per year (0 = no cap). */
  sdiWageBase: decimal('sdi_wage_base', { precision: 15, scale: 2 }).notNull().default('0'),
  /** State unemployment account number (printed on the quarterly wage worksheet). */
  accountNumber: varchar('account_number', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const workersCompCodes = pgTable('workers_comp_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  code: varchar('code', { length: 20 }).notNull(),
  description: varchar('description', { length: 255 }),
  /** Premium per $100 of wages, e.g. 1.2500. */
  ratePer100: decimal('rate_per_100', { precision: 9, scale: 4 }).notNull().default('0'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- team home (0054): "Needs attention" inbox ----

/** Per-user snooze / dismiss of a "Needs attention" item (key built by lib/services/attention.ts). */
export const attentionItemStates = pgTable('attention_item_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  itemKey: varchar('item_key', { length: 200 }).notNull(),
  /** Hidden until this moment (snooze). */
  snoozedUntil: timestamp('snoozed_until'),
  /** Hidden for good (until the item's key changes). */
  dismissedAt: timestamp('dismissed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** When a backup of the company file was made (feeds the inbox's "back up" reminder). */
export const backupLog = pgTable('backup_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  userId: uuid('user_id').references(() => users.id),
  /** 'full' (whole file) | 'company' (one company) | 'auto' (desktop app) | 'quick' (Back up now) */
  kind: varchar('kind', { length: 20 }).notNull(),
  filename: varchar('filename', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Undo tokens (ux/undo, drizzle/0057): one per save / void / delete made from a form. Holds the
 * record as it was before the action (`snapshot`) and its version right after (`afterVersion`),
 * so lib/services/undo.ts can apply the inverse through the normal services — once, by the same
 * user, within 30 seconds, and only while nobody has changed the record since.
 */
export const undoActions = pgTable('undo_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  userId: uuid('user_id').references(() => users.id),
  entityType: varchar('entity_type', { length: 40 }).notNull(),
  /** The record the undo acts on (for a journal-entry edit: the replacement entry). */
  entityId: varchar('entity_id', { length: 64 }),
  /** 'create' | 'update' | 'void' | 'delete' */
  kind: varchar('kind', { length: 10 }).notNull(),
  /** 'pending' (snapshot taken, action not confirmed) | 'armed' | 'undone' */
  status: varchar('status', { length: 12 }).notNull().default('pending'),
  label: text('label'),
  snapshot: jsonb('snapshot'),
  afterVersion: timestamp('after_version'),
  result: jsonb('result'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  armedAt: timestamp('armed_at'),
  expiresAt: timestamp('expires_at'),
  undoneAt: timestamp('undone_at'),
});

// ---- receipt capture (0050): local OCR + phone upload ----
/**
 * One receipt photo / PDF in the Doc Center inbox and what was read from it. The file is an
 * `attachments` row (unfiled until saved, then filed to the transaction it became).
 * `version` is the record-locking counter (re-reading and saving must name it).
 */
export const receiptScans = pgTable('receipt_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'cascade' }).notNull(),
  /** 'desktop' | 'phone' */
  source: varchar('source', { length: 20 }).notNull().default('desktop'),
  /** 'pending' | 'processing' | 'ready' | 'failed' | 'saved' */
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  /** How the text was read: 'pdf-text' | 'ocr' | 'vision' | 'none' */
  method: varchar('method', { length: 20 }),
  /** Plain-language note shown on the review screen (why nothing could be read, ...). */
  message: text('message'),
  vendorName: varchar('vendor_name', { length: 255 }),
  /** ISO day yyyy-mm-dd as printed on the receipt. */
  receiptDate: varchar('receipt_date', { length: 10 }),
  total: decimal('total', { precision: 15, scale: 2 }),
  subtotal: decimal('subtotal', { precision: 15, scale: 2 }),
  tax: decimal('tax', { precision: 15, scale: 2 }),
  cardLast4: varchar('card_last4', { length: 4 }),
  cardBrand: varchar('card_brand', { length: 40 }),
  reference: varchar('reference', { length: 60 }),
  confidence: jsonb('confidence').$type<Record<string, number>>(),
  rawText: text('raw_text'),
  /** The transaction the receipt became: 'expense' (check / cash / card charge) | 'bill'. */
  txnType: varchar('txn_type', { length: 20 }),
  txnId: uuid('txn_id'),
  createdBy: uuid('created_by'),
  version: integer('version').notNull().default(1),
  processingStartedAt: timestamp('processing_started_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Short-lived phone upload links (only the SHA-256 of the token is stored). */
export const receiptUploadTokens = pgTable('receipt_upload_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  createdBy: uuid('created_by'),
  expiresAt: timestamp('expires_at').notNull(),
  maxUploads: integer('max_uploads').notNull().default(20),
  uploadCount: integer('upload_count').notNull().default(0),
  revokedAt: timestamp('revoked_at'),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- month-end close (drizzle/0051_monthend.sql) ----
/** What one person recorded about one month-end checklist step (lib/services/monthEndClose.ts). */
export interface MonthEndStepState {
  reviewed?: boolean;
  reviewedBy?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  note?: string | null;
  /** Set when the step was skipped on purpose; the reason is required. */
  skipReason?: string | null;
}

/** Guided month-end close: review progress per company + period end. */
export const monthEndCloses = pgTable('month_end_closes', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** 'YYYY-MM-DD' period end. Unique per company. */
  periodEnd: varchar('period_end', { length: 10 }).notNull(),
  /** 'open' | 'closed' */
  status: varchar('status', { length: 20 }).notNull().default('open'),
  steps: jsonb('steps').$type<Record<string, MonthEndStepState>>().notNull().default({}),
  scanRanAt: timestamp('scan_ran_at'),
  closedAt: timestamp('closed_at'),
  closedBy: uuid('closed_by').references(() => users.id),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  /** Record-locking version. */
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ---- gapsb (0056): password policy — earlier password hashes (bcrypt) for "don't reuse" ----
export const passwordHistory = pgTable('password_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Accountant's Copy (0053, PARITY I1) ----
// One row per Accountant's Copy. The client's row (side 'client', status 'outstanding') locks
// transactions dated on/before dividingDate; the accountant's working copy carries the same row
// flipped to side 'accountant'. See lib/services/accountantCopy/.
export const accountantCopies = pgTable('accountant_copies', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  /** 'client' | 'accountant' */
  side: varchar('side', { length: 12 }).notNull().default('client'),
  /** client: 'outstanding' | 'imported' | 'cancelled'; accountant: 'open' */
  status: varchar('status', { length: 16 }).notNull().default('outstanding'),
  /** 'YYYY-MM-DD' */
  dividingDate: varchar('dividing_date', { length: 10 }).notNull(),
  fileToken: varchar('file_token', { length: 64 }).notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  openedAt: timestamp('opened_at'),
  baselineLogSeq: integer('baseline_log_seq'),
  exportedAt: timestamp('exported_at'),
  exportCount: integer('export_count').notNull().default(0),
  importedAt: timestamp('imported_at'),
  importedBy: uuid('imported_by'),
  cancelledAt: timestamp('cancelled_at'),
  cancelledBy: uuid('cancelled_by'),
  accountantNote: text('accountant_note'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** Accountant side: record versions at the moment the copy was opened (the delta baseline). */
export const accountantCopyBaseline = pgTable('accountant_copy_baseline', {
  id: uuid('id').primaryKey().defaultRandom(),
  copyId: uuid('copy_id').references(() => accountantCopies.id, { onDelete: 'cascade' }).notNull(),
  /** 'journal_entry' | 'expense' | 'account' | 'class' | 'invoice' | 'customer' | ... (accountantCopy/docs.ts) */
  entityType: varchar('entity_type', { length: 40 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  version: timestamp('version'),
  /** 0058: md5 of the record's substance (derived values left out), see accountantCopy/docs.ts. */
  digest: text('digest'),
  /** 0058: 'void' | 'draft' | 'live', or the status of an estimate / sales order / purchase order. */
  state: varchar('state', { length: 20 }),
});
