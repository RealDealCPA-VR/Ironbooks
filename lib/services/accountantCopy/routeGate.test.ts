/** Accountant's Copy route gate: which saves an accountant may make in the working copy. */
import { describe, it, expect } from 'vitest';
import { accountantCopyAllowsApi } from './routeGate';
import { accountantMayPost } from './guard';

describe("Accountant's Copy route gate", () => {
  it('allows the saves the changes file carries back, plus housekeeping', () => {
    for (const p of [
      '/api/journal-entries',
      '/api/journal-entries/abc/reverse',
      '/api/expenses/abc',
      '/api/transfers',
      '/api/transfers/abc',
      '/api/deposits',
      '/api/deposits/abc',
      '/api/accounts/abc',
      '/api/classes',
      // Format 3: sales, purchases, payments, applications, reconciliations, names and items.
      '/api/invoices',
      '/api/invoices/abc',
      '/api/invoices/abc/post',
      '/api/invoices/batch',
      '/api/invoices/statement-charges',
      '/api/sales-receipts/abc',
      '/api/credit-memos',
      '/api/credit-memos/abc',
      '/api/payments',
      '/api/payments/abc',
      '/api/payments/journal-items',
      '/api/bills/abc',
      '/api/bill-payments',
      '/api/bill-payments/journal-items',
      '/api/vendor-credits/abc',
      '/api/item-receipts',
      '/api/estimates/abc',
      '/api/sales-orders',
      '/api/purchase-orders/abc',
      '/api/inventory',
      '/api/reconciliations',
      '/api/reconciliations/abc',
      '/api/reconciliations/undo',
      '/api/customers',
      '/api/customers/abc',
      '/api/vendors/abc',
      '/api/items',
      '/api/lists/other-names',
      '/api/lists/other-names/abc',
      // Housekeeping.
      '/api/accountant-copy/changes',
      '/api/auth/logout',
      '/api/preferences/my',
      '/api/undo/prepare',
      '/api/backups/run',
      '/api/attention/state',
      '/api/sandbox/discard',
      '/api/command-bar',
    ]) {
      expect(accountantCopyAllowsApi(p), p).toBe(true);
    }
  });

  it('refuses saves that could not be sent back to the client (and what QB forbids)', () => {
    for (const p of [
      '/api/merge',
      '/api/preferences',
      '/api/accountant/reclassify',
      '/api/accountant/write-off',
      '/api/journal-entriesX',
      '/api/invoicesX',
      '/api/inventory-transfers',
      '/api/inventory/physical-count',
      '/api/inventory/value-adjust',
      '/api/inventory/batch-count',
      '/api/invoices/retainage',
      '/api/estimates/expire',
      '/api/reconciliations/abc/pay',
      '/api/customers/bulk',
      '/api/items/bulk',
      '/api/vendors/bulk',
      '/api/items/change-prices',
      '/api/lists/terms',
      '/api/lists/payment-methods/abc',
      '/api/receiving/bill',
      '/api/payroll/run',
      '/api/bank-rules',
      '/api/bank-accounts',
      '/api/receipts/abc/save',
      '/api/month-end-close/close',
      '/api/attention/invoice-reminder',
      '/api/condense',
      '/api/employees',
    ]) {
      expect(accountantCopyAllowsApi(p), p).toBe(false);
    }
  });

  it('only sources the changes file carries may post in the copy', () => {
    for (const ok of [null, 'manual', 'reversal:1', 'expense:1', 'deposit:1', 'deposit:pending', 'invoice:1', 'invoice-cogs:1', 'salesreceipt:1', 'credit_memo:1', 'creditmemo-cogs:1', 'customer:1', 'payment:1', 'bill:1', 'vendor:1', 'vendor_credit:1', 'item_receipt:1', 'item:1', 'reconciliation:1']) {
      expect(accountantMayPost(ok), String(ok)).toBe(true);
    }
    for (const no of ['refund:1', 'bounced:1', 'paycheck:1', 'condense:1', 'loan:1', 'fixed_asset:1', 'account:1', 'hca:1', 'qbgl:x', 'cc-payment:1', 'tax_agency:1']) {
      expect(accountantMayPost(no), no).toBe(false);
    }
  });
});
