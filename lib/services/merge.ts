/**
 * Merge duplicate customers and vendors — QuickBooks-parity "Merge" feature.
 *
 * Both merge functions:
 *  1. Verify both records exist and belong to the active company.
 *  2. Reject self-merges (fromId === toId).
 *  3. Reassign every related document from `from` to `to` inside a single
 *     database transaction so the operation is atomic.
 *  4. Deactivate the `from` record (soft-delete — isActive = false).
 *  5. Write a pair of audit_logs rows (one for the deactivation, one for the
 *     merge action).
 *
 * GL integrity note: no journal entries are touched. Existing entries already
 * reference the correct A/R / A/P accounts; only the customer/vendor FK on the
 * sub-ledger documents is updated. The GL and trial balance remain balanced.
 */
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
  bouncedChecks,
  collectionNotes,
  customers,
  vendors,
  invoices,
  paymentsReceived,
  estimates,
  creditMemos,
  salesOrders,
  bills,
  billPayments,
  expenses,
  vendorCredits,
  purchaseOrders,
  jobs,
  billLines,
  expenseLines,
  customerPrices,
  timeEntries,
  mileageLogs,
  accounts,
  journalEntryLines,
  bankAccounts,
  items,
  taxAgencies,
  invoiceLines,
  salesReceipts,
  salesReceiptLines,
  transfers,
  bankTransactions,
  transactionRules,
  budgetLines,
  creditMemoLines,
  vendorCreditLines,
  expenseReportLines,
  purchaseOrderLines,
  deposits,
  fixedAssets,
  recurringTemplates,
  memorizedReports,
  depositLines,
  workingTbNotes,
} from '@/lib/db/schema';
import { toAmountString } from '@/lib/money';
import { type ServiceContext, notFound, validation, inTransaction, writeAudit } from './_base';
import { allowLedgerRewrite } from './posting';
import { qbAccountTypeOf } from '@/lib/accountTypes';
import { repointForeignKeys } from './lists/references';
import { moveNotesAndTodos } from './lists/notes';
import { repointBankRuleAccount } from './bankRules';
import { assertListDeleteAllowed } from './accountantCopy/guard';
import { foreignCode, homeCode } from './fxLines';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MergeCustomersInput {
  /** The duplicate to fold away — will be deactivated. */
  fromId: string;
  /** The master record to keep. */
  toId: string;
}

/** review5 fx: refuse merging two names / accounts that use different currencies. */
async function assertSameCurrency(
  ctx: ServiceContext,
  a: string | null | undefined,
  b: string | null | undefined,
  what: string,
): Promise<void> {
  const home = await homeCode(ctx);
  const ca = foreignCode(a ?? null, home);
  const cb = foreignCode(b ?? null, home);
  if (ca !== cb) {
    throw validation(
      `${what} use different currencies (${ca ?? home ?? 'home currency'} and ${cb ?? home ?? 'home currency'}), so they can't be merged. Only names and accounts in the same currency can be merged.`,
    );
  }
}

export interface MergeVendorsInput {
  fromId: string;
  toId: string;
}

export interface MergeResult {
  reassigned: {
    invoices: number;
    paymentsReceived: number;
    estimates: number;
    creditMemos: number;
    salesOrders: number;
  } | {
    bills: number;
    billPayments: number;
    expenses: number;
    vendorCredits: number;
    purchaseOrders: number;
  };
  deactivatedId: string;
}

// ---------------------------------------------------------------------------
// mergeCustomers
// ---------------------------------------------------------------------------

/**
 * Merge `fromId` into `toId`. Reassigns all A/R sub-ledger documents and
 * deactivates the `from` customer. Runs inside a single transaction.
 */
export async function mergeCustomers(
  ctx: ServiceContext,
  { fromId, toId }: MergeCustomersInput,
): Promise<MergeResult> {
  await assertListDeleteAllowed(ctx, 'merge', 'customers'); // Accountant's Copy (I1)
  if (fromId === toId) {
    throw validation('Cannot merge a customer with itself.');
  }

  // Verify both customers belong to this company before entering a transaction.
  const [fromRow] = await ctx.db
    .select({ id: customers.id, displayName: customers.displayName, isActive: customers.isActive })
    .from(customers)
    .where(and(eq(customers.id, fromId), eq(customers.companyId, ctx.companyId)));
  if (!fromRow) throw notFound(`Customer ${fromId}`);

  const [toRow] = await ctx.db
    .select({ id: customers.id, displayName: customers.displayName })
    .from(customers)
    .where(and(eq(customers.id, toId), eq(customers.companyId, ctx.companyId)));
  if (!toRow) throw notFound(`Customer ${toId}`);

  return inTransaction(ctx, async (tx) => {
    // Reassign every customer-linked table.
    const invRows = await tx.db
      .update(invoices)
      .set({ customerId: toId, updatedAt: new Date() })
      .where(and(eq(invoices.customerId, fromId), eq(invoices.companyId, tx.companyId)))
      .returning({ id: invoices.id });

    const pmtRows = await tx.db
      .update(paymentsReceived)
      .set({ customerId: toId })
      .where(and(eq(paymentsReceived.customerId, fromId), eq(paymentsReceived.companyId, tx.companyId)))
      .returning({ id: paymentsReceived.id });

    const estRows = await tx.db
      .update(estimates)
      .set({ customerId: toId, updatedAt: new Date() })
      .where(and(eq(estimates.customerId, fromId), eq(estimates.companyId, tx.companyId)))
      .returning({ id: estimates.id });

    const cmRows = await tx.db
      .update(creditMemos)
      .set({ customerId: toId })
      .where(and(eq(creditMemos.customerId, fromId), eq(creditMemos.companyId, tx.companyId)))
      .returning({ id: creditMemos.id });

    const soRows = await tx.db
      .update(salesOrders)
      .set({ customerId: toId })
      .where(and(eq(salesOrders.customerId, fromId), eq(salesOrders.companyId, tx.companyId)))
      .returning({ id: salesOrders.id });

    // Sub-ledger tables that ALSO carry customerId — previously orphaned by the merge.
    const jobRows = await tx.db
      .update(jobs)
      .set({ customerId: toId })
      .where(and(eq(jobs.customerId, fromId), eq(jobs.companyId, tx.companyId)))
      .returning({ id: jobs.id });

    const timeRows = await tx.db
      .update(timeEntries)
      .set({ customerId: toId })
      .where(and(eq(timeEntries.customerId, fromId), eq(timeEntries.companyId, tx.companyId)))
      .returning({ id: timeEntries.id });

    const mileageRows = await tx.db
      .update(mileageLogs)
      .set({ customerId: toId })
      .where(and(eq(mileageLogs.customerId, fromId), eq(mileageLogs.companyId, tx.companyId)))
      .returning({ id: mileageLogs.id });

    // wave2 sales: bounced-check records and collections notes follow the customer.
    await tx.db
      .update(bouncedChecks)
      .set({ customerId: toId })
      .where(and(eq(bouncedChecks.customerId, fromId), eq(bouncedChecks.companyId, tx.companyId)));
    await tx.db
      .update(collectionNotes)
      .set({ customerId: toId })
      .where(and(eq(collectionNotes.customerId, fromId), eq(collectionNotes.companyId, tx.companyId)));

    // customerPrices: drop any from-customer price whose item is already priced for the
    // survivor (no unique constraint exists, but we avoid creating duplicate price rows),
    // then re-point the remainder.
    const toPriceItems = (
      await tx.db
        .select({ itemId: customerPrices.itemId })
        .from(customerPrices)
        .where(and(eq(customerPrices.customerId, toId), eq(customerPrices.companyId, tx.companyId)))
    ).map((r) => r.itemId);
    if (toPriceItems.length > 0) {
      await tx.db
        .delete(customerPrices)
        .where(
          and(
            eq(customerPrices.customerId, fromId),
            eq(customerPrices.companyId, tx.companyId),
            inArray(customerPrices.itemId, toPriceItems),
          ),
        );
    }
    const priceRows = await tx.db
      .update(customerPrices)
      .set({ customerId: toId })
      .where(and(eq(customerPrices.customerId, fromId), eq(customerPrices.companyId, tx.companyId)))
      .returning({ id: customerPrices.id });

    // billLines / expenseLines have no companyId column — scope via their parent's companyId.
    const billLineRows = await tx.db
      .update(billLines)
      .set({ customerId: toId })
      .where(
        and(
          eq(billLines.customerId, fromId),
          inArray(
            billLines.billId,
            tx.db.select({ id: bills.id }).from(bills).where(eq(bills.companyId, tx.companyId)),
          ),
        ),
      )
      .returning({ id: billLines.id });

    const expenseLineRows = await tx.db
      .update(expenseLines)
      .set({ customerId: toId })
      .where(
        and(
          eq(expenseLines.customerId, fromId),
          inArray(
            expenseLines.expenseId,
            tx.db.select({ id: expenses.id }).from(expenses).where(eq(expenses.companyId, tx.companyId)),
          ),
        ),
      )
      .returning({ id: expenseLines.id });

    // Named General Journal lines (QB "Name" column): the duplicate's A/R open items and any
    // other customer-named lines follow the customer. Only the name changes — amounts and
    // accounts stay put — but posted lines are immutable outside a sanctioned rewrite.
    const jelRows = await repointJournalNames(tx, 'customer', fromId, toId);
    // Wave-2 lists: sweep every remaining foreign key to the customer (sales receipts, tables
    // added by other modules, ...) and carry dated notes / to-dos over. The sub-customer
    // hierarchy is handled explicitly so the survivor can never become its own parent.
    // The survivor may sit anywhere below the duplicate (child, grandchild, ...): re-pointing the
    // duplicate's children onto it would then close a loop (B under C under B). Lift the
    // survivor to the duplicate's own parent first.
    const tree = await tx.db
      .select({ id: customers.id, parentId: customers.parentId })
      .from(customers)
      .where(eq(customers.companyId, tx.companyId));
    const parentOf = new Map(tree.map((r) => [r.id, r.parentId]));
    const seen = new Set<string>();
    let cur: string | null | undefined = parentOf.get(toId);
    let survivorBelowDuplicate = false;
    while (cur && !seen.has(cur)) {
      if (cur === fromId) { survivorBelowDuplicate = true; break; }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    if (survivorBelowDuplicate) {
      await tx.db
        .update(customers)
        .set({ parentId: parentOf.get(fromId) ?? null, updatedAt: new Date() })
        .where(eq(customers.id, toId));
    }
    const sweptCustomer = await repointForeignKeys(tx, 'customers', fromId, toId);
    const movedCustomerNotes = await moveNotesAndTodos(tx, 'customer', fromId, toId);

    // Deactivate the from-customer.
    await tx.db
      .update(customers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(customers.id, fromId));

    // Audit: deactivation of the from-record.
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'customer',
      entityId: fromId,
      oldValues: { isActive: fromRow.isActive, displayName: fromRow.displayName },
      newValues: { isActive: false, mergedInto: toId },
    });

    // Audit: the merge operation itself (recorded on the surviving record).
    await writeAudit(tx, {
      action: 'update',
      entityType: 'customer',
      entityId: toId,
      newValues: {
        mergedFrom: fromId,
        reassigned: {
          invoices: invRows.length,
          paymentsReceived: pmtRows.length,
          estimates: estRows.length,
          creditMemos: cmRows.length,
          salesOrders: soRows.length,
          jobs: jobRows.length,
          timeEntries: timeRows.length,
          mileageLogs: mileageRows.length,
          customerPrices: priceRows.length,
          billLines: billLineRows.length,
          expenseLines: expenseLineRows.length,
          journalEntryLines: jelRows,
        },
        otherReferences: sweptCustomer,
        notesAndTodos: movedCustomerNotes,
      },
    });

    return {
      reassigned: {
        invoices: invRows.length,
        paymentsReceived: pmtRows.length,
        estimates: estRows.length,
        creditMemos: cmRows.length,
        salesOrders: soRows.length,
      },
      deactivatedId: fromId,
    };
  });
}

// ---------------------------------------------------------------------------
// mergeVendors
// ---------------------------------------------------------------------------

/**
 * Merge `fromId` into `toId`. Reassigns all A/P sub-ledger documents and
 * deactivates the `from` vendor. Runs inside a single transaction.
 */
export async function mergeVendors(
  ctx: ServiceContext,
  { fromId, toId }: MergeVendorsInput,
): Promise<MergeResult> {
  await assertListDeleteAllowed(ctx, 'merge', 'vendors'); // Accountant's Copy (I1)
  if (fromId === toId) {
    throw validation('Cannot merge a vendor with itself.');
  }

  const [fromRow] = await ctx.db
    .select({ id: vendors.id, displayName: vendors.displayName, isActive: vendors.isActive, currency: vendors.currency })
    .from(vendors)
    .where(and(eq(vendors.id, fromId), eq(vendors.companyId, ctx.companyId)));
  if (!fromRow) throw notFound(`Vendor ${fromId}`);

  const [toRow] = await ctx.db
    .select({ id: vendors.id, displayName: vendors.displayName, currency: vendors.currency })
    .from(vendors)
    .where(and(eq(vendors.id, toId), eq(vendors.companyId, ctx.companyId)));
  if (!toRow) throw notFound(`Vendor ${toId}`);
  // review5 fx: a vendor's transactions are in the vendor's currency (QB merges names in the same
  // currency only); merged, a home vendor would own foreign bills and credits it can't settle.
  await assertSameCurrency(ctx, fromRow.currency, toRow.currency, `"${fromRow.displayName}" and "${toRow.displayName}"`);

  return inTransaction(ctx, async (tx) => {
    const billRows = await tx.db
      .update(bills)
      .set({ vendorId: toId, updatedAt: new Date() })
      .where(and(eq(bills.vendorId, fromId), eq(bills.companyId, tx.companyId)))
      .returning({ id: bills.id });

    const bpRows = await tx.db
      .update(billPayments)
      .set({ vendorId: toId })
      .where(and(eq(billPayments.vendorId, fromId), eq(billPayments.companyId, tx.companyId)))
      .returning({ id: billPayments.id });

    const expRows = await tx.db
      .update(expenses)
      .set({ vendorId: toId })
      .where(and(eq(expenses.vendorId, fromId), eq(expenses.companyId, tx.companyId)))
      .returning({ id: expenses.id });

    const vcRows = await tx.db
      .update(vendorCredits)
      .set({ vendorId: toId })
      .where(and(eq(vendorCredits.vendorId, fromId), eq(vendorCredits.companyId, tx.companyId)))
      .returning({ id: vendorCredits.id });

    const poRows = await tx.db
      .update(purchaseOrders)
      .set({ vendorId: toId })
      .where(and(eq(purchaseOrders.vendorId, fromId), eq(purchaseOrders.companyId, tx.companyId)))
      .returning({ id: purchaseOrders.id });

    // Named General Journal lines follow the vendor (A/P open items from journal entries).
    const jelRows = await repointJournalNames(tx, 'vendor', fromId, toId);
    // Wave-2 lists: sweep every remaining foreign key to the vendor (items' preferred vendor,
    // item receipts, tables added by other modules, ...) and carry notes / to-dos over.
    const sweptVendor = await repointForeignKeys(tx, 'vendors', fromId, toId);
    const movedVendorNotes = await moveNotesAndTodos(tx, 'vendor', fromId, toId);

    // Deactivate the from-vendor.
    await tx.db
      .update(vendors)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(vendors.id, fromId));

    await writeAudit(tx, {
      action: 'delete',
      entityType: 'vendor',
      entityId: fromId,
      oldValues: { isActive: fromRow.isActive, displayName: fromRow.displayName },
      newValues: { isActive: false, mergedInto: toId },
    });

    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor',
      entityId: toId,
      newValues: {
        mergedFrom: fromId,
        reassigned: {
          bills: billRows.length,
          billPayments: bpRows.length,
          expenses: expRows.length,
          vendorCredits: vcRows.length,
          purchaseOrders: poRows.length,
          journalEntryLines: jelRows,
        },
        otherReferences: sweptVendor,
        notesAndTodos: movedVendorNotes,
      },
    });

    return {
      reassigned: {
        bills: billRows.length,
        billPayments: bpRows.length,
        expenses: expRows.length,
        vendorCredits: vcRows.length,
        purchaseOrders: poRows.length,
      },
      deactivatedId: fromId,
    };
  });
}

// ---------------------------------------------------------------------------
// Named journal lines
// ---------------------------------------------------------------------------

/**
 * Re-point the QB "Name" on journal entry lines from one customer/vendor to another. The
 * entity id is a UUID already verified to belong to this company, so the match is tenant-safe
 * even though journal_entry_lines has no companyId column. Posted lines are immutable outside
 * a sanctioned rewrite, so this runs under allowLedgerRewrite('merge') in the caller's
 * transaction. Accounts and amounts are untouched, so every entry stays balanced.
 */
async function repointJournalNames(
  tx: ServiceContext,
  entityType: 'customer' | 'vendor',
  fromId: string,
  toId: string,
): Promise<number> {
  await allowLedgerRewrite(tx, 'merge');
  const rows = await tx.db
    .update(journalEntryLines)
    .set({ entityId: toId })
    .where(and(eq(journalEntryLines.entityType, entityType), eq(journalEntryLines.entityId, fromId)))
    .returning({ id: journalEntryLines.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// mergeAccounts
// ---------------------------------------------------------------------------

/**
 * Accounts the posting services find by their NUMBER (accountIdByCode / eq(accounts.code, …)):
 * invoices / credit memos / receipts (1200 A/R, 4000 income fallback), bills / bill payments /
 * vendor credits (2000 A/P), payments and deposits (1050 Undeposited Funds), retainage (1250),
 * inventory (1300 Inventory Asset, 5000 COGS), item receipts (2050 accrual), sales tax (2200),
 * payroll (2300, 6500, 6510, and 1000 as the fallback bank), fiscal close (3900 Retained
 * Earnings), realized exchange gain/loss (6900). Merged away, such an account is deactivated
 * but keeps receiving every new posting — hidden, and split from the survivor again — so it
 * must be the account that is kept.
 */
const CODE_POSTED_ACCOUNTS = new Set([
  '1000', '1050', '1200', '1250', '1300', '2000', '2050', '2200', '2300', '3900', '4000', '5000', '6500', '6510', '6900',
]);

export interface MergeAccountsInput {
  /** The duplicate GL account to fold away — will be deactivated with a zero balance. */
  fromId: string;
  /** The surviving GL account. Must be the same type as `fromId`. */
  toId: string;
}

export interface MergeAccountsResult {
  /** Row counts re-pointed per table/column. */
  reassigned: Record<string, number>;
  deactivatedId: string;
  /** The survivor's cached balance, recomputed from the posted ledger after the merge. */
  newBalance: string;
}

/**
 * Merge GL account `fromId` into `toId` (QB: rename an account to an existing
 * name → "Merge accounts"). Same-type only. Re-points every table that carries
 * an account FK — the journal lines themselves (the GL history), item account
 * mappings, bank-account links, bank rules, budgets, document lines, transfers,
 * fixed-asset mappings, tax agencies, and accountIds embedded in recurring
 * templates / memorized-report configs — then deactivates the source and audits.
 * Cached balances follow the re-pointed lines automatically (DB trigger, see
 * drizzle/0017_team_ledger.sql): the survivor ends with the full ledger balance
 * and the source with zero.
 *
 * Tenancy note: several line tables (journal_entry_lines, invoice_lines, …)
 * have no companyId column. `fromId` is a UUID primary key verified above to
 * belong to this company, so `WHERE account_id = fromId` can only ever match
 * this company's rows — no parent-scoped subquery is needed.
 */
export async function mergeAccounts(
  ctx: ServiceContext,
  { fromId, toId }: MergeAccountsInput,
): Promise<MergeAccountsResult> {
  await assertListDeleteAllowed(ctx, 'merge', 'accounts'); // Accountant's Copy (I1)
  if (fromId === toId) {
    throw validation('Cannot merge an account with itself.');
  }

  const [fromRow] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, fromId), eq(accounts.companyId, ctx.companyId)));
  if (!fromRow) throw notFound(`Account ${fromId}`);

  const [toRow] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, toId), eq(accounts.companyId, ctx.companyId)));
  if (!toRow) throw notFound(`Account ${toId}`);

  if (fromRow.type !== toRow.type) {
    throw validation(
      `Accounts must be the same type to merge (${fromRow.type} vs ${toRow.type}).`,
    );
  }
  // QuickBooks only merges accounts of the same account type (Bank with Bank, Other Current
  // Asset with Other Current Asset, ...). This also keeps A/R and A/P clean: every line on them
  // carries a customer/vendor name, so unnamed lines from another type can never land there,
  // and non-posting accounts can never receive posted history.
  if (qbAccountTypeOf(fromRow) !== qbAccountTypeOf(toRow)) {
    throw validation(
      `"${fromRow.name}" and "${toRow.name}" are different kinds of account, so they can't be merged. Only accounts of the same type can be merged.`,
    );
  }
  if (fromRow.subtype === 'non_posting' || toRow.subtype === 'non_posting') {
    throw validation('Non-posting accounts (estimates, purchase orders) cannot be merged.');
  }
  // review5 fx: a foreign-currency account's lines carry amounts in ITS currency (register,
  // reconciliation, Home Currency Adjustment read them); QB only merges accounts in the same
  // currency.
  await assertSameCurrency(ctx, fromRow.currency, toRow.currency, `"${fromRow.name}" and "${toRow.name}"`);
  if (CODE_POSTED_ACCOUNTS.has(fromRow.code)) {
    throw validation(
      `"${fromRow.code} ${fromRow.name}" is an account Ironbooks posts to on its own (invoices, bills, payments, inventory, sales tax or payroll), so it is the one to keep. Merge "${toRow.code} ${toRow.name}" into it instead — you can rename it afterwards.`,
    );
  }

  return inTransaction(ctx, async (tx) => {
    const reassigned: Record<string, number> = {};
    const count = async (
      key: string,
      rows: PromiseLike<Array<{ id: string }>>,
    ): Promise<void> => {
      reassigned[key] = (reassigned[key] ?? 0) + (await rows).length;
    };

    // --- The GL itself: journal entry lines (posted, draft AND void history). ---
    // Re-pointing lines of posted entries is a sanctioned ledger rewrite (same-type accounts,
    // so every entry stays balanced; the DB trigger moves the balance with the lines).
    await allowLedgerRewrite(tx, 'merge');
    await count(
      'journalEntryLines',
      tx.db
        .update(journalEntryLines)
        .set({ accountId: toId })
        .where(eq(journalEntryLines.accountId, fromId))
        .returning({ id: journalEntryLines.id }),
    );

    // --- Sub-account hierarchy: if the survivor was a child of the source, hoist it
    // to the source's parent FIRST so re-pointing children cannot self-parent it. ---
    if (toRow.parentId === fromId) {
      await tx.db
        .update(accounts)
        .set({ parentId: fromRow.parentId ?? null, updatedAt: new Date() })
        .where(eq(accounts.id, toId));
    }
    await count(
      'childAccounts',
      tx.db
        .update(accounts)
        .set({ parentId: toId, updatedAt: new Date() })
        .where(eq(accounts.parentId, fromId))
        .returning({ id: accounts.id }),
    );

    // --- Banking. ---
    await count(
      'bankAccounts',
      tx.db
        .update(bankAccounts)
        .set({ accountId: toId, updatedAt: new Date() })
        .where(eq(bankAccounts.accountId, fromId))
        .returning({ id: bankAccounts.id }),
    );
    await count(
      'bankTransactions',
      tx.db
        .update(bankTransactions)
        .set({ suggestedAccountId: toId })
        .where(eq(bankTransactions.suggestedAccountId, fromId))
        .returning({ id: bankTransactions.id }),
    );
    await count(
      'transactionRules',
      tx.db
        .update(transactionRules)
        .set({ setAccountId: toId })
        .where(eq(transactionRules.setAccountId, fromId))
        .returning({ id: transactionRules.id }),
    );
    // bankrules: rule splits, learning history and "no thanks" dismissals follow the account.
    reassigned.bankRuleLearning = await repointBankRuleAccount(tx, fromId, toId);

    // --- Item + vendor + tax-agency account mappings. ---
    await count(
      'items',
      tx.db
        .update(items)
        .set({ incomeAccountId: toId, updatedAt: new Date() })
        .where(eq(items.incomeAccountId, fromId))
        .returning({ id: items.id }),
    );
    await count(
      'items',
      tx.db
        .update(items)
        .set({ expenseAccountId: toId, updatedAt: new Date() })
        .where(eq(items.expenseAccountId, fromId))
        .returning({ id: items.id }),
    );
    await count(
      'items',
      tx.db
        .update(items)
        .set({ assetAccountId: toId, updatedAt: new Date() })
        .where(eq(items.assetAccountId, fromId))
        .returning({ id: items.id }),
    );
    await count(
      'vendors',
      tx.db
        .update(vendors)
        .set({ defaultExpenseAccountId: toId, updatedAt: new Date() })
        .where(eq(vendors.defaultExpenseAccountId, fromId))
        .returning({ id: vendors.id }),
    );
    await count(
      'taxAgencies',
      tx.db
        .update(taxAgencies)
        .set({ liabilityAccountId: toId })
        .where(eq(taxAgencies.liabilityAccountId, fromId))
        .returning({ id: taxAgencies.id }),
    );

    // --- Document headers + lines that carry account FKs. ---
    await count(
      'invoiceLines',
      tx.db
        .update(invoiceLines)
        .set({ accountId: toId })
        .where(eq(invoiceLines.accountId, fromId))
        .returning({ id: invoiceLines.id }),
    );
    await count(
      'paymentsReceived',
      tx.db
        .update(paymentsReceived)
        .set({ depositAccountId: toId })
        .where(eq(paymentsReceived.depositAccountId, fromId))
        .returning({ id: paymentsReceived.id }),
    );
    await count(
      'salesReceipts',
      tx.db
        .update(salesReceipts)
        .set({ depositAccountId: toId })
        .where(eq(salesReceipts.depositAccountId, fromId))
        .returning({ id: salesReceipts.id }),
    );
    await count(
      'salesReceiptLines',
      tx.db
        .update(salesReceiptLines)
        .set({ accountId: toId })
        .where(eq(salesReceiptLines.accountId, fromId))
        .returning({ id: salesReceiptLines.id }),
    );
    await count(
      'billLines',
      tx.db
        .update(billLines)
        .set({ accountId: toId })
        .where(eq(billLines.accountId, fromId))
        .returning({ id: billLines.id }),
    );
    await count(
      'billPayments',
      tx.db
        .update(billPayments)
        .set({ paymentAccountId: toId })
        .where(eq(billPayments.paymentAccountId, fromId))
        .returning({ id: billPayments.id }),
    );
    await count(
      'expenses',
      tx.db
        .update(expenses)
        .set({ paymentAccountId: toId })
        .where(eq(expenses.paymentAccountId, fromId))
        .returning({ id: expenses.id }),
    );
    await count(
      'expenseLines',
      tx.db
        .update(expenseLines)
        .set({ accountId: toId })
        .where(eq(expenseLines.accountId, fromId))
        .returning({ id: expenseLines.id }),
    );
    await count(
      'creditMemoLines',
      tx.db
        .update(creditMemoLines)
        .set({ accountId: toId })
        .where(eq(creditMemoLines.accountId, fromId))
        .returning({ id: creditMemoLines.id }),
    );
    await count(
      'vendorCreditLines',
      tx.db
        .update(vendorCreditLines)
        .set({ accountId: toId })
        .where(eq(vendorCreditLines.accountId, fromId))
        .returning({ id: vendorCreditLines.id }),
    );
    await count(
      'expenseReportLines',
      tx.db
        .update(expenseReportLines)
        .set({ accountId: toId })
        .where(eq(expenseReportLines.accountId, fromId))
        .returning({ id: expenseReportLines.id }),
    );
    await count(
      'purchaseOrderLines',
      tx.db
        .update(purchaseOrderLines)
        .set({ accountId: toId })
        .where(eq(purchaseOrderLines.accountId, fromId))
        .returning({ id: purchaseOrderLines.id }),
    );
    await count(
      'deposits',
      tx.db
        .update(deposits)
        .set({ depositAccountId: toId })
        .where(eq(deposits.depositAccountId, fromId))
        .returning({ id: deposits.id }),
    );
    await count(
      'transfers',
      tx.db
        .update(transfers)
        .set({ fromAccountId: toId })
        .where(eq(transfers.fromAccountId, fromId))
        .returning({ id: transfers.id }),
    );
    await count(
      'transfers',
      tx.db
        .update(transfers)
        .set({ toAccountId: toId })
        .where(eq(transfers.toAccountId, fromId))
        .returning({ id: transfers.id }),
    );

    // --- Budgets. ---
    await count(
      'budgetLines',
      tx.db
        .update(budgetLines)
        .set({ accountId: toId })
        .where(eq(budgetLines.accountId, fromId))
        .returning({ id: budgetLines.id }),
    );

    // --- Fixed assets (three separate account mappings). ---
    await count(
      'fixedAssets',
      tx.db
        .update(fixedAssets)
        .set({ assetAccountId: toId })
        .where(eq(fixedAssets.assetAccountId, fromId))
        .returning({ id: fixedAssets.id }),
    );
    await count(
      'fixedAssets',
      tx.db
        .update(fixedAssets)
        .set({ depreciationExpenseAccountId: toId })
        .where(eq(fixedAssets.depreciationExpenseAccountId, fromId))
        .returning({ id: fixedAssets.id }),
    );
    await count(
      'fixedAssets',
      tx.db
        .update(fixedAssets)
        .set({ accumulatedDepreciationAccountId: toId })
        .where(eq(fixedAssets.accumulatedDepreciationAccountId, fromId))
        .returning({ id: fixedAssets.id }),
    );

    // --- JSONB payloads: recurring templates + memorized reports may embed
    // accountIds anywhere in their document JSON. UUIDs are globally unique, so a
    // serialize → string-replace → re-parse round trip re-points them safely. ---
    let recurringCount = 0;
    const templates = await tx.db
      .select({ id: recurringTemplates.id, template: recurringTemplates.template })
      .from(recurringTemplates)
      .where(eq(recurringTemplates.companyId, tx.companyId));
    for (const t of templates) {
      const json = JSON.stringify(t.template);
      if (json.includes(fromId)) {
        await tx.db
          .update(recurringTemplates)
          .set({ template: JSON.parse(json.split(fromId).join(toId)) })
          .where(eq(recurringTemplates.id, t.id));
        recurringCount++;
      }
    }
    reassigned['recurringTemplates'] = recurringCount;

    let memorizedCount = 0;
    const reports = await tx.db
      .select({ id: memorizedReports.id, config: memorizedReports.config })
      .from(memorizedReports)
      .where(eq(memorizedReports.companyId, tx.companyId));
    for (const r of reports) {
      const json = JSON.stringify(r.config);
      if (json.includes(fromId)) {
        await tx.db
          .update(memorizedReports)
          .set({ config: JSON.parse(json.split(fromId).join(toId)) })
          .where(eq(memorizedReports.id, r.id));
        memorizedCount++;
      }
    }
    reassigned['memorizedReports'] = memorizedCount;

    // --- Columns without a foreign key and ids embedded in text. ---
    // Early-payment discount account on received payments (plain uuid column, no FK).
    await count(
      'paymentsReceivedDiscount',
      tx.db
        .update(paymentsReceived)
        .set({ discountAccountId: toId })
        .where(and(eq(paymentsReceived.discountAccountId, fromId), eq(paymentsReceived.companyId, tx.companyId)))
        .returning({ id: paymentsReceived.id }),
    );
    // Deposit-line markers ("cashback:<accountId>", any "<prefix>:<accountId>"): re-saving a
    // deposit rebuilds its GL from these, so they must name the survivor.
    await count(
      'depositLineMarkers',
      tx.db
        .update(depositLines)
        .set({ description: sql`replace(${depositLines.description}, ${fromId}, ${toId})` })
        .where(
          and(
            like(depositLines.description, `%:${fromId}`),
            inArray(
              depositLines.depositId,
              tx.db.select({ id: deposits.id }).from(deposits).where(eq(deposits.companyId, tx.companyId)),
            ),
          ),
        )
        .returning({ id: depositLines.id }),
    );
    // Working trial balance notes are unique per (account, period): fold a duplicate period's
    // note into the survivor's before the sweep re-points the rest.
    const fromNotes = await tx.db.select().from(workingTbNotes).where(eq(workingTbNotes.accountId, fromId));
    for (const n of fromNotes) {
      const [keep] = await tx.db
        .select()
        .from(workingTbNotes)
        .where(and(eq(workingTbNotes.accountId, toId), eq(workingTbNotes.periodEnd, n.periodEnd)));
      if (!keep) continue;
      const note = [keep.note, n.note].filter((x) => x && x.trim()).join('\n') || null;
      await tx.db
        .update(workingTbNotes)
        .set({ note, workpaperRef: keep.workpaperRef ?? n.workpaperRef, updatedAt: new Date() })
        .where(eq(workingTbNotes.id, keep.id));
      await tx.db.delete(workingTbNotes).where(eq(workingTbNotes.id, n.id));
    }
    // Every other FOREIGN KEY to accounts (deposit lines, payroll items, loans, bounced checks,
    // check documents, landed cost, AI auto-apply log, working TB notes, and any table added
    // later) follows the survivor. The hierarchy was handled above.
    const swept = await repointForeignKeys(tx, 'accounts', fromId, toId, { skip: ['accounts.parent_id'] });
    for (const [k, n] of Object.entries(swept)) reassigned[`fk:${k}`] = n;

    // --- Cached balances: the DB trigger already moved the balance along with the
    // re-pointed lines (survivor = full ledger, source = 0). Read the survivor's
    // balance back and deactivate the source — its history now lives on the survivor. ---
    const [survivor] = await tx.db
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.id, toId));
    const newBalance = toAmountString(survivor?.balance ?? 0);

    await tx.db
      .update(accounts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(accounts.id, fromId));

    // Audit: deactivation of the source account.
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'account',
      entityId: fromId,
      oldValues: {
        isActive: fromRow.isActive,
        code: fromRow.code,
        name: fromRow.name,
        balance: fromRow.balance,
      },
      newValues: { isActive: false, balance: '0.00', mergedInto: toId },
    });

    // Audit: the merge operation itself (on the surviving account).
    await writeAudit(tx, {
      action: 'update',
      entityType: 'account',
      entityId: toId,
      oldValues: { balance: toRow.balance },
      newValues: { mergedFrom: fromId, balance: newBalance, reassigned },
    });

    return { reassigned, deactivatedId: fromId, newBalance };
  });
}
