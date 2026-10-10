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
import { and, eq, inArray } from 'drizzle-orm';
import {
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
} from '@/lib/db/schema';
import { toAmountString } from '@/lib/money';
import { type ServiceContext, notFound, validation, inTransaction, writeAudit } from './_base';
import { allowLedgerRewrite } from './posting';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MergeCustomersInput {
  /** The duplicate to fold away — will be deactivated. */
  fromId: string;
  /** The master record to keep. */
  toId: string;
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
        },
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
  if (fromId === toId) {
    throw validation('Cannot merge a vendor with itself.');
  }

  const [fromRow] = await ctx.db
    .select({ id: vendors.id, displayName: vendors.displayName, isActive: vendors.isActive })
    .from(vendors)
    .where(and(eq(vendors.id, fromId), eq(vendors.companyId, ctx.companyId)));
  if (!fromRow) throw notFound(`Vendor ${fromId}`);

  const [toRow] = await ctx.db
    .select({ id: vendors.id, displayName: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.id, toId), eq(vendors.companyId, ctx.companyId)));
  if (!toRow) throw notFound(`Vendor ${toId}`);

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
        },
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
// mergeAccounts
// ---------------------------------------------------------------------------

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
