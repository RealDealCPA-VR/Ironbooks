/**
 * "Needs attention" item kinds and their plain-language names. Pure data (no DB imports) so the
 * inbox UI and the service (lib/services/attention.ts) share it.
 */
export const ATTENTION_KINDS = [
  'bank_txn',
  'overdue_invoice',
  'bill_due',
  'ai_error',
  'reconcile',
  'payroll_tax',
  'todo',
  'backup',
  'undeposited',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Plain-language group names (filters / counts in the UI). */
export const ATTENTION_KIND_LABELS: Record<AttentionKind, string> = {
  bank_txn: 'Bank transactions to sort',
  overdue_invoice: 'Customers who owe you',
  bill_due: 'Bills to pay',
  ai_error: 'Possible mistakes',
  reconcile: 'Accounts to reconcile',
  payroll_tax: 'Payroll taxes to deposit',
  todo: 'To-dos',
  backup: 'Backup',
  undeposited: 'Money to deposit',
};

/** Window event the inbox fires after it changes something (the sidebar badge refreshes). */
export const ATTENTION_CHANGED_EVENT = 'attention:changed';
