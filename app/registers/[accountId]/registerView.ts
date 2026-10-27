/**
 * What the account register shows while it loads (pure, unit-tested in lib/ui.review5.test.ts).
 *
 * The register reloads after every transaction typed into its entry row. The grid (and the entry
 * row in it) must stay on screen during that reload: replacing it with a spinner unmounted the
 * entry row, so after Enter the cursor was lost instead of waiting in the Date field of the next
 * blank row (QB keeps you in the register to type the next one), and every save re-read the
 * whole chart of accounts and name lists. The spinner is for the first load only.
 */
export type RegisterBody = 'spinner' | 'unavailable' | 'grid';

export function registerBody(loading: boolean, hasResult: boolean): RegisterBody {
  if (hasResult) return 'grid';
  return loading ? 'spinner' : 'unavailable';
}

/**
 * The entry row is offered on the unfiltered register only — the search the shown rows were
 * loaded with, not what is being typed into the search box (typing there used to unmount a
 * half-typed transaction before Apply was even pressed).
 */
export function showEntryRow(appliedSearch: string): boolean {
  return !appliedSearch.trim();
}

/** What a register row needs for Ctrl+G and Ctrl+O. */
export interface RegisterRowKeys {
  journalEntryId: string;
  description: string;
  memo: string | null;
  debit: string | null;
  credit: string | null;
  foreignDebit?: string | null;
  foreignCredit?: string | null;
  /** The other account on the entry, or "-split-" (id null) for several. */
  otherAccount?: { id: string | null; label: string } | null;
}

/** Debit / credit as the register's Increase / Decrease column, per the account's normal side. */
export function registerAmount(
  row: Pick<RegisterRowKeys, 'debit' | 'credit' | 'foreignDebit' | 'foreignCredit'>,
  accountType: string,
  key: 'increase' | 'decrease',
  foreign = false,
): string | null {
  const debitNormal = accountType === 'asset' || accountType === 'expense';
  const dr = foreign ? (row.foreignDebit ?? null) : row.debit;
  const cr = foreign ? (row.foreignCredit ?? null) : row.credit;
  const increase = debitNormal ? dr : cr;
  const decrease = debitNormal ? cr : dr;
  return key === 'increase' ? increase : decrease;
}

/** Ctrl+G: the other account's register, opened at the same transaction (null for a split). */
export function transferHref(row: Pick<RegisterRowKeys, 'otherAccount' | 'journalEntryId'>): string | null {
  const id = row.otherAccount?.id;
  if (!id) return null;
  return `/registers/${encodeURIComponent(id)}?${new URLSearchParams({ entry: row.journalEntryId }).toString()}`;
}

/**
 * Ctrl+O: what the blank line gets from this row — payee, the other account, memo, which column
 * and the amount (null for a split, or a row with no amount). Lib/keyboardTargets.ts
 * CopiedTransaction shape.
 */
export function copyOfRow(
  row: RegisterRowKeys,
  accountType: string,
  foreign: boolean,
): { payee: string; accountId: string; accountLabel: string; memo: string; side: 'increase' | 'decrease'; amount: string } | null {
  const other = row.otherAccount;
  if (!other?.id) return null;
  for (const side of ['increase', 'decrease'] as const) {
    const amount = registerAmount(row, accountType, side, foreign);
    if (amount && /[1-9]/.test(amount)) {
      return {
        payee: row.description ?? '',
        accountId: other.id,
        accountLabel: other.label,
        memo: row.memo && row.memo !== row.description ? row.memo : '',
        side,
        amount: amount.replace(/^-/, ''),
      };
    }
  }
  return null;
}
