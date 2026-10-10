/**
 * Report-level ledger assertions — the last line of defence.
 *
 * The database already makes an unbalanced posted entry impossible (drizzle/0017_team_ledger.sql),
 * and every balance-sheet report is built so that Assets = Liabilities + Equity holds BY
 * CONSTRUCTION (all accounts from the same posted ledger rows, with net income folded into
 * equity). These checks are therefore expected to be unreachable. If one ever fires, the ledger
 * is corrupt (e.g. a legacy file written before the database guards existed) and the report
 * refuses to render misleading numbers: it throws a loud INTEGRITY error instead, pointing the
 * user at Data Integrity (Verify / Rebuild) to locate the bad entry.
 */
import { Money, toAmountString, type MoneyInput } from '@/lib/money';
import { ServiceError } from './_base';

export class LedgerIntegrityError extends ServiceError {
  constructor(message: string, details?: unknown) {
    super('INTERNAL', `INTEGRITY: ${message}`, details);
    this.name = 'LedgerIntegrityError';
  }
}

function fail(message: string, details: Record<string, string>): never {
  const err = new LedgerIntegrityError(
    `${message} The ledger is corrupt — open Data Integrity to find the out-of-balance entry.`,
    details,
  );
  // Loud by design: this should be unreachable, so make sure it is noticed in logs too.
  console.error('[ledger] INTEGRITY violation', err.message, details);
  throw err;
}

/** Trial balance: total debits must equal total credits exactly (2dp ledger amounts). */
export function assertTrialBalanceBalanced(
  report: string,
  totalDebit: MoneyInput,
  totalCredit: MoneyInput,
): void {
  if (!Money.eq(Money.round2(totalDebit), Money.round2(totalCredit))) {
    fail(
      `${report} is out of balance: debits ${toAmountString(totalDebit)} ≠ credits ${toAmountString(totalCredit)}.`,
      { report, totalDebit: toAmountString(totalDebit), totalCredit: toAmountString(totalCredit) },
    );
  }
}

/** Balance sheet: Assets must equal Liabilities + Equity exactly. */
export function assertBalanceSheetBalanced(
  report: string,
  totalAssets: MoneyInput,
  totalLiabilities: MoneyInput,
  totalEquity: MoneyInput,
): void {
  const rhs = Money.add(totalLiabilities, totalEquity);
  if (!Money.eq(Money.round2(totalAssets), Money.round2(rhs))) {
    fail(
      `${report} does not balance: assets ${toAmountString(totalAssets)} ≠ liabilities + equity ${toAmountString(rhs)}.`,
      {
        report,
        totalAssets: toAmountString(totalAssets),
        totalLiabilities: toAmountString(totalLiabilities),
        totalEquity: toAmountString(totalEquity),
      },
    );
  }
}
