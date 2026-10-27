/**
 * Which journal entries the Journal screen (and DELETE / reverse on /api/journal-entries) may void
 * or reverse directly. Pure (no database imports) so the page can hide the buttons with the same
 * rule the service enforces (lib/services/journal.ts voidEntry / reverseEntry).
 *
 * Allowed: user-authored General Journal entries and pure-GL postings that no subledger document
 * tracks. Everything else (invoices, bills, payments, deposits, paychecks, ...) must be voided
 * through its source document, otherwise the document (open balance, aging, inventory, payroll)
 * and the GL silently disagree — the same rule updateEntry applies to edits. Refunds may be
 * VOIDED here (the posting engine gives the credit back), but not reversed. Fixed-asset
 * depreciation entries may be VOIDED here too (voidEntry takes the period off the asset's
 * schedule and accumulated depreciation), but not reversed (a reversal would leave the schedule
 * saying the period was depreciated). Year-end closing entries (fiscal-close:<year>) may be
 * VOIDED (that takes the close back) but not reversed: the reversal is an ordinary entry dated in
 * the next year, which that year's Profit & Loss counts (reports leave only fiscal-close entries
 * out), so it showed the whole closed year's income and expenses a second time.
 */
// tax_agency / sales_tax_adj are GL-only sales-tax entries (Batch Void treats them as journals too);
// qbgl entries are the imported QuickBooks General Ledger, which no subledger document tracks;
// cc-payment is the "pay the card balance" entry after a credit-card reconciliation (payCreditCard),
// which has no document of its own.
const JOURNAL_SCREEN_PREFIXES = [
  'reversal:',
  'fiscal-close:',
  'adjusting:',
  'account:',
  'tax_agency:',
  'sales_tax_adj:',
  'qbgl:',
  'cc-payment:',
];

/** Exact source refs of GL-only entries (no ':<id>' suffix). FX gain/loss adjustments (currencies.ts). */
const JOURNAL_SCREEN_EXACT = new Set(['fx_adjustment']);

export function isJournalScreenEntry(sourceRef: string | null | undefined, op: 'void' | 'reverse'): boolean {
  if (!sourceRef || sourceRef === 'manual') return true;
  if (JOURNAL_SCREEN_EXACT.has(sourceRef)) return true;
  if (op === 'void' && (sourceRef.startsWith('refund:') || sourceRef.startsWith('fixed_asset:'))) return true;
  if (op === 'reverse' && sourceRef.startsWith('fiscal-close:')) return false;
  return JOURNAL_SCREEN_PREFIXES.some((p) => sourceRef.startsWith(p));
}
