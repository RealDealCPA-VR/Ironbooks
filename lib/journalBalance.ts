/**
 * Live "debits must equal credits" check for the journal-entry form (app/journal/page.tsx).
 *
 * Decimal-safe (lib/money.ts) — the form used to sum JS floats, which can show a 0.01
 * difference on perfectly balanced input. The server (postJournalEntry) remains the final
 * authority; this only drives the on-screen difference indicator and disables Save until the
 * entry is balanced, so the user is never surprised by an UNBALANCED error.
 */
import Decimal from 'decimal.js';
import { toAmountString } from '@/lib/money';

export interface JournalLineInput {
  accountId: string;
  debit: string;
  credit: string;
}

export interface JournalBalance {
  totalDebits: string;
  totalCredits: string;
  /** totalDebits - totalCredits (2dp string; negative when credits are larger). */
  difference: string;
  balanced: boolean;
  /** Lines (1-based) whose amount is not a valid money number (e.g. "12.3.4", "-5"), or that
   *  have both a debit and a credit. */
  invalidLines: number[];
  /** Lines with an amount but no account, or an account with no amount. */
  incompleteLines: number[];
  /** Number of lines with an account selected. */
  accountLines: number;
  /** True when the entry can be saved (balanced, >= 2 account lines, all lines valid). */
  canSave: boolean;
  /** Plain-language reason Save is disabled (null when canSave). */
  blocker: string | null;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
/** Commas are accepted only as thousands separators in groups of three ("1,250.00"). */
const GROUPED_RE = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;
/** Ledger columns are numeric(15,2): at most 13 digits before the decimal point. */
const MAX_AMOUNT = new Decimal('9999999999999.99');

/**
 * Canonical form of a typed amount: trimmed, thousands separators removed ("1,250.00 " ->
 * "1250.00"). The Save gate validates THIS string and the page must send THIS string (see
 * journalPayloadAmount) — otherwise the form could show "Balanced" for text the API rejects.
 * Any other comma (e.g. "12,50" typed with a comma as the decimal mark) is left in place so
 * the amount stays invalid instead of silently becoming 1250.
 */
export function normalizeAmount(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  return GROUPED_RE.test(s) ? s.replace(/,/g, '') : s;
}

/** Amount as sent to /api/journal-entries: normalized, or undefined when blank. */
export function journalPayloadAmount(raw: string | null | undefined): string | undefined {
  const s = normalizeAmount(raw);
  return s ? s : undefined;
}

function parseAmount(raw: string): Decimal | null | 'invalid' | 'tooLarge' {
  const s = normalizeAmount(raw);
  if (!s) return null;
  if (!AMOUNT_RE.test(s)) return 'invalid';
  const d = new Decimal(s);
  return d.greaterThan(MAX_AMOUNT) ? 'tooLarge' : d;
}

export function computeJournalBalance(lines: JournalLineInput[]): JournalBalance {
  let debits = new Decimal(0);
  let credits = new Decimal(0);
  const invalidLines: number[] = [];
  const incompleteLines: number[] = [];
  const twoSidedLines: number[] = [];
  const tooLargeLines: number[] = [];
  let accountLines = 0;

  lines.forEach((l, i) => {
    const d = parseAmount(l.debit);
    const c = parseAmount(l.credit);
    // postJournalEntry rejects a line carrying both a debit and a credit.
    const twoSided = d instanceof Decimal && !d.isZero() && c instanceof Decimal && !c.isZero();
    if (twoSided) twoSidedLines.push(i + 1);
    const tooLarge = d === 'tooLarge' || c === 'tooLarge';
    if (tooLarge) tooLargeLines.push(i + 1);
    if (d === 'invalid' || c === 'invalid' || tooLarge || twoSided) invalidLines.push(i + 1);
    if (d instanceof Decimal) debits = debits.plus(d);
    if (c instanceof Decimal) credits = credits.plus(c);
    const hasAmount =
      (d instanceof Decimal && !d.isZero()) || (c instanceof Decimal && !c.isZero());
    if (l.accountId) accountLines++;
    if ((hasAmount && !l.accountId) || (l.accountId && !hasAmount)) incompleteLines.push(i + 1);
  });

  const diff = debits.minus(credits);
  const balanced = diff.isZero() && debits.greaterThan(0);

  let blocker: string | null = null;
  if (invalidLines.length) {
    const n = invalidLines[0];
    const bothSides = twoSidedLines.includes(n);
    blocker = bothSides
      ? `Line ${n} has both a debit and a credit. Use one side per line (split it into two lines).`
      : tooLargeLines.includes(n)
        ? `Line ${n} has an amount that is too large (the most one entry can hold is 9,999,999,999,999.99).`
        : `Line ${n} has an amount that isn’t a number (use digits like 1250.50 or 1,250.50; commas only between thousands).`;
  } else if (debits.greaterThan(MAX_AMOUNT) || credits.greaterThan(MAX_AMOUNT)) {
    blocker = 'The total of this entry is too large to record (over 9,999,999,999,999.99). Split it into smaller entries.';
  } else if (accountLines < 2) {
    blocker = 'Choose an account on at least two lines.';
  } else if (incompleteLines.length) {
    blocker = `Line ${incompleteLines[0]} needs both an account and an amount (or clear it).`;
  } else if (debits.isZero() && credits.isZero()) {
    blocker = 'Enter the amounts.';
  } else if (!diff.isZero()) {
    const amt = toAmountString(diff.abs());
    blocker = diff.greaterThan(0)
      ? `Debits are ${amt} more than credits. Add ${amt} to the credit side (or lower a debit).`
      : `Credits are ${amt} more than debits. Add ${amt} to the debit side (or lower a credit).`;
  }

  return {
    totalDebits: toAmountString(debits),
    totalCredits: toAmountString(credits),
    difference: toAmountString(diff),
    balanced,
    invalidLines,
    incompleteLines,
    accountLines,
    canSave: blocker === null && balanced,
    blocker,
  };
}

/** One line of the journal-entry form (app/journal/page.tsx). */
export interface JournalFormLine {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  classId: string;
  /** QB "Name" column: "<kind>:<id>" (customer / vendor / employee / other) or ''. */
  name: string;
}

/** One line as /api/journal-entries (and a memorized journal entry) takes it. */
export interface JournalPayloadLine {
  accountId: string;
  debit: string | undefined;
  credit: string | undefined;
  memo: string | null;
  classId: string | null;
  entityType: string | null;
  entityId: string | null;
}

/**
 * The lines the form sends — for Save AND for Memorize, so a memorized entry is exactly what a
 * save would post. (Memorize used to drop the Name column, so a memorized entry with an A/R or
 * A/P line could never be entered: those lines need their customer / vendor.) Lines without an
 * account are left out; amounts are what the Save gate validated ("1,250.00 " -> "1250.00").
 */
export function journalPayloadLines(lines: JournalFormLine[]): JournalPayloadLine[] {
  return lines
    .filter((l) => l.accountId)
    .map((l) => {
      const sep = l.name ? l.name.indexOf(':') : -1;
      const entityType = sep > 0 ? l.name.slice(0, sep) : null;
      const entityId = sep > 0 ? l.name.slice(sep + 1) : null;
      return {
        accountId: l.accountId,
        debit: journalPayloadAmount(l.debit),
        credit: journalPayloadAmount(l.credit),
        memo: l.memo.trim() || null,
        classId: l.classId || null,
        entityType: entityType || null,
        entityId: entityId || null,
      };
    });
}
