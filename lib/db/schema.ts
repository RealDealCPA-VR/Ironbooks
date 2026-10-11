import { pgTable, uuid, varchar, text, timestamp, boolean, decimal, integer, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums
export const accountTypeEnum = pgEnum('account_type', ['asset', 'liability', 'equity', 'revenue', 'expense']);
export const accountSubtypeEnum = pgEnum('account_subtype', [
  'checking', 'savings', 'accounts_receivable', 'inventory', 'fixed_assets',
  'accounts_payable', 'credit_card', 'long_term_liability',
  'owners_equity', 'retained_earnings',
  'sales', 'service_revenue', 'other_income',
  'cost_of_goods_sold', 'operating_expenses', 'payroll', 'taxes'
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
  /** wave2 purchases: currency of a bank / credit-card account (null = home currency). */
  currency: varchar('currency', { length: 3 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
  isActive: boolean('is_active').notNull().default(true),
  /** Values for company-defined custom fields ({ [fieldName]: value }). */
  customFields: jsonb('custom_fields').$type<Record<string, string>>(),
  // Advanced Inventory (team inventory): scan code (unique per company), serial/lot
  // tracking mode ('none' | 'serial' | 'lot'), and unit weight for landed-cost allocation.
  barcode: varchar('barcode', { length: 100 }),
  trackingMode: varchar('tracking_mode', { length: 10 }).notNull().default('none'),
  weight: decimal('weight', { precision: 15, scale: 4 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ---- Sales tax ----
export const taxAgencies = pgTable('tax_agencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  liabilityAccountId: uuid('liability_account_id').references(() => accounts.id),
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
});

// ---- Invoices (A/R) ----
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  invoiceNumber: integer('invoice_number').notNull(),
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
});

// ---- Payments received (A/R) ----
export const paymentsReceived = pgTable('payments_received', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---- Sales receipts (paid-at-point-of-sale; posts income + payment in one step) ----
export const salesReceipts = pgTable('sales_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id),
  receiptNumber: integer('receipt_number').notNull(),
  date: timestamp('date').notNull(),
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
});

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
});

// ---- Bill payments (A/P) ----
export const billPayments = pgTable('bill_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
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
});

export const billPaymentApplications = pgTable('bill_payment_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  billPaymentId: uuid('bill_payment_id').references(() => billPayments.id).notNull(),
  billId: uuid('bill_id').references(() => bills.id).notNull(),
  amountApplied: decimal('amount_applied', { precision: 15, scale: 2 }).notNull(),
  /** wave2 purchases: home-currency A/P relieved by this application (null = amountApplied). */
  amountHome: decimal('amount_home', { precision: 15, scale: 2 }),
});

// ---- Direct expenses / checks (non-bill spend) ----
export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id),
  payeeName: varchar('payee_name', { length: 255 }),
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
});

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
});

// ---- Bank transfers ----
export const transfers = pgTable('transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  date: timestamp('date').notNull(),
  fromAccountId: uuid('from_account_id').references(() => accounts.id).notNull(),
  toAccountId: uuid('to_account_id').references(() => accounts.id).notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  /** wave2 purchases: transfers can be voided (reverses the entry). */
  voidedAt: timestamp('voided_at'),
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
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const paychecks = pgTable('paychecks', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
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
  voidedAt: timestamp('voided_at'),
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const budgetLines = pgTable('budget_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  budgetId: uuid('budget_id').references(() => budgets.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  classId: uuid('class_id').references(() => classes.id), // optional class dimension
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
});

// ---- Attachments / document store ----
export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  filename: varchar('filename', { length: 255 }).notNull(),
  storagePath: text('storage_path').notNull(),
  mimeType: varchar('mime_type', { length: 100 }),
  sizeBytes: integer('size_bytes'),
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
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  memoNumber: integer('memo_number').notNull(),
  date: timestamp('date').notNull(),
  status: docStatusEnum('status').notNull().default('open'),
  subtotal: decimal('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
  taxAmount: decimal('tax_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  unapplied: decimal('unapplied', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Portion refunded by check (reduces unapplied). */
  refundedAmount: decimal('refunded_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
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
});

// ---- Vendor credits (A/P credits) ----
export const vendorCredits = pgTable('vendor_credits', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  date: timestamp('date').notNull(),
  status: docStatusEnum('status').notNull().default('open'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  unapplied: decimal('unapplied', { precision: 15, scale: 2 }).notNull().default('0'),
  /** Portion refunded by check (reduces unapplied). */
  refundedAmount: decimal('refunded_amount', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const vendorCreditLines = pgTable('vendor_credit_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  vendorCreditId: uuid('vendor_credit_id').references(() => vendorCredits.id).notNull(),
  accountId: uuid('account_id').references(() => accounts.id).notNull(),
  description: text('description'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
  lineOrder: integer('line_order').notNull().default(0),
});

// ---- Sales orders (convert to invoice) ----
export const salesOrders = pgTable('sales_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
  customerId: uuid('customer_id').references(() => customers.id).notNull(),
  orderNumber: integer('order_number').notNull(),
  date: timestamp('date').notNull(),
  status: docStatusEnum('status').notNull().default('open'),
  subtotal: decimal('subtotal', { precision: 15, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  convertedInvoiceId: uuid('converted_invoice_id'),
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
  vendorId: uuid('vendor_id').references(() => vendors.id).notNull(),
  poNumber: integer('po_number').notNull(),
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
});

// ---- Item receipts (QB "Receive Items" before the bill arrives) ----
export const itemReceipts = pgTable('item_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id).notNull(),
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
});

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
  depositAccountId: uuid('deposit_account_id').references(() => accounts.id).notNull(),
  date: timestamp('date').notNull(),
  total: decimal('total', { precision: 15, scale: 2 }).notNull().default('0'),
  memo: text('memo'),
  postedEntryId: uuid('posted_entry_id').references(() => journalEntries.id),
  voidedAt: timestamp('voided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const depositLines = pgTable('deposit_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  depositId: uuid('deposit_id').references(() => deposits.id).notNull(),
  paymentId: uuid('payment_id').references(() => paymentsReceived.id),
  description: text('description'),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull().default('0'),
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
  billable: boolean('billable').notNull().default(false),
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
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
  /** 'logout' | 'signed_out_by_admin' | 'expired' */
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
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
