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

// ---------------------------------------------------------------------------
// Item keys ('<kind>:<id>'): the exact shape each kind uses, so a snooze / dismiss can only be
// stored for a key the inbox could have produced (a bad id would otherwise reach a uuid query).
// ---------------------------------------------------------------------------

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ISO_DAY = '[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])';
const ISO_MONTH = '[0-9]{4}-(?:0[1-9]|1[0-2])';

export const UUID_RE = new RegExp(`^${UUID}$`);

/** The part after '<kind>:' for each kind. */
const KEY_ID_RE: Record<AttentionKind, RegExp> = {
  bank_txn: UUID_RE,
  overdue_invoice: UUID_RE,
  bill_due: UUID_RE,
  ai_error: UUID_RE,
  todo: UUID_RE,
  undeposited: UUID_RE,
  reconcile: new RegExp(`^${UUID}:${ISO_DAY}$`),
  payroll_tax: new RegExp(`^${ISO_MONTH}$`),
  backup: new RegExp(`^(?:${ISO_DAY}|never)$`),
};

/** Split an item key into its kind and id, or null when it is not a key the inbox produces. */
export function parseAttentionKey(key: unknown): { kind: AttentionKind; id: string } | null {
  if (typeof key !== 'string' || key.length > 200) return null;
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!(ATTENTION_KINDS as readonly string[]).includes(kind)) return null;
  return KEY_ID_RE[kind as AttentionKind].test(id) ? { kind: kind as AttentionKind, id } : null;
}

/** The currency an item's amount is in: its own (foreign-currency document) or the home one. */
export function attentionAmountCurrency(data: Record<string, unknown> | undefined, homeCurrency: string): string {
  const c = data?.currency;
  return typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : homeCurrency;
}
