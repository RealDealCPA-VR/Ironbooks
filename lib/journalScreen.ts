/**
 * Which journal entries the Journal screen (and DELETE / reverse on /api/journal-entries) may void
 * or reverse directly. Pure (no database imports) so the page can hide the buttons with the same
 * rule the service enforces (lib/services/journal.ts voidEntry / reverseEntry).
 *
 * Allowed: user-authored General Journal entries and pure-GL postings that no subledger document
 * tracks. Everything else (invoices, bills, payments, deposits, paychecks, ...) must be voided
 * through its source document, otherwise the document (open balance, aging, inventory, payroll)
 * and the GL silently disagree — the same rule updateEntry applies to edits. Refunds may be
 * VOIDED here (the posting engine gives the credit back), but not reversed.
 */
// tax_agency / sales_tax_adj are GL-only sales-tax entries (Batch Void treats them as journals too);
// qbgl entries are the imported QuickBooks General Ledger, which no subledger document tracks.
const JOURNAL_SCREEN_PREFIXES = [
  'reversal:',
  'fiscal-close:',
  'adjusting:',
  'account:',
  'tax_agency:',
  'sales_tax_adj:',
  'qbgl:',
];

export function isJournalScreenEntry(sourceRef: string | null | undefined, op: 'void' | 'reverse'): boolean {
  if (!sourceRef || sourceRef === 'manual') return true;
  if (op === 'void' && sourceRef.startsWith('refund:')) return true;
  return JOURNAL_SCREEN_PREFIXES.some((p) => sourceRef.startsWith(p));
}
