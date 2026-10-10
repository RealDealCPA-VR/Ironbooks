/**
 * Cash-Basis Balance Sheet.
 *
 * ACCOUNTING BASIS OVERVIEW
 * ─────────────────────────
 * On an accrual Balance Sheet, Accounts Receivable (AR, code 1200) and Accounts Payable (AP,
 * code 2000) represent amounts owed but not yet exchanged in cash. A cash-basis Balance Sheet
 * excludes these balances because cash-basis accounting recognises no receivables or payables —
 * only cash transactions count.
 *
 * CONVERSION METHOD (Balance Sheet indirect adjustment)
 * ──────────────────────────────────────────────────────
 * 1. Start from the standard accrual Balance Sheet (balanceSheet from reports.ts), which is
 *    itself balanced by construction from the posted ledger.
 * 2. Remove every Accounts Receivable account from the assets section: subtype
 *    'accounts_receivable' (A/R, Retainage Receivable, …) or legacy code 1200.
 * 3. Remove every Accounts Payable account from the liabilities section: code 2000, or subtype
 *    'accounts_payable' whose name says "Accounts Payable" (the subtype alone is not trusted —
 *    it is the default for any liability created without a subtype, e.g. a loan).
 * 4. Reduce Retained Earnings / net income by (arRemoved − apRemoved): that difference is
 *    exactly the earnings recognised on accrual but not yet realised in cash.
 *
 * BALANCED BY CONSTRUCTION — THE ONLY PLUG
 * ────────────────────────────────────────
 * The single plug (equityAdjustment) is computed from the SAME ledger-derived AR/AP balances
 * that were removed, never from a difference of report totals, so it cannot hide a ledger
 * error: if the accrual sheet balances (asserted), the cash sheet balances identically.
 * `assertBalanceSheetBalanced` re-checks the result and throws a loud INTEGRITY error otherwise.
 *
 * WHY THIS KEEPS THE EQUATION BALANCED
 * ──────────────────────────────────────
 * The accrual sheet satisfies: Assets = Liabilities + Equity.
 * We remove ΔA from assets and ΔL from liabilities, so the right side changes by −ΔL.
 * To restore balance we must reduce assets by ΔA, which means equity must shrink by (ΔA − ΔL),
 * i.e. equity' = equity − (arRemoved − apRemoved).
 *
 * In practice most companies carry AR > 0 and AP > 0 so cash-basis equity is lower than
 * accrual equity (unreceived revenue is excluded from both sides).
 */
import { eq } from 'drizzle-orm';
import { accounts } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { assertBalanceSheetBalanced } from './ledgerAssert';
import { balanceSheet, type ReportLine } from './reports';

// ---- COA codes for the mandatory adjustments (legacy files without subtypes) ----
const AR_CODE = '1200'; // Accounts Receivable (asset, debit-normal)
const AP_CODE = '2000'; // Accounts Payable     (liability, credit-normal)

/** Is this asset account an Accounts Receivable account (excluded on a cash basis)? */
function isReceivable(a: { code: string; subtype: string }): boolean {
  return a.code === AR_CODE || a.subtype === 'accounts_receivable';
}

/** Is this liability account an Accounts Payable account (excluded on a cash basis)? */
function isPayable(a: { code: string; name: string; subtype: string }): boolean {
  return a.code === AP_CODE || (a.subtype === 'accounts_payable' && /accounts\s*payable/i.test(a.name));
}

/** Shape of a single AR/AP line that was removed from the accrual sheet. */
export interface RemovedLine {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

/** The cash-basis Balance Sheet returned by balanceSheetCashBasis. */
export interface BalanceSheetCashBasis {
  basis: 'cash';
  /** Asset lines after removing AR (code 1200). */
  assets: ReportLine[];
  /** Liability lines after removing AP (code 2000). */
  liabilities: ReportLine[];
  /** Equity lines from the accrual sheet (unchanged except totals). */
  equity: ReportLine[];
  /**
   * Cash-basis retained earnings / net income to date = accrual earnings − equityAdjustment,
   * so the equity lines plus this line add up exactly to totals.totalEquity.
   */
  retainedEarnings: string;
  /** The accrual-basis figure the cash one was derived from. */
  accrualRetainedEarnings: string;
  /** Totals after the cash-basis adjustments. */
  totals: {
    totalAssets: string;
    totalLiabilities: string;
    totalEquity: string;
    /** Total liabilities + equity (should equal totalAssets). */
    totalLiabilitiesAndEquity: string;
  };
  /** True when totalAssets = totalLiabilities + totalEquity (exact; asserted). */
  balanced: boolean;
  /** Date the report is computed as of (undefined = all-time). */
  asOf?: string;
  /**
   * Details of what was adjusted.
   *  arRemoved: total AR balance removed from assets (positive = AR existed).
   *  apRemoved: total AP balance removed from liabilities (positive = AP existed).
   *  equityAdjustment: amount deducted from equity to restore the accounting equation
   *                    = arRemoved − apRemoved.
   */
  adjustments: {
    arRemoved: string;
    apRemoved: string;
    equityAdjustment: string;
    removedArLines: RemovedLine[];
    removedApLines: RemovedLine[];
  };
}

/**
 * Compute a cash-basis Balance Sheet as of an optional date.
 *
 * The function delegates to the canonical `balanceSheet()` from reports.ts (do NOT edit
 * reports.ts) and then strips AR and AP, adjusting equity so that the accounting equation
 * Assets = Liabilities + Equity continues to hold.
 *
 * @param ctx   Service context — scoped to ctx.companyId.
 * @param asOf  Optional upper date bound (defaults to all posted activity).
 * @returns     A BalanceSheetCashBasis with basis:'cash' and an adjustments summary.
 */
export async function balanceSheetCashBasis(
  ctx: ServiceContext,
  asOf?: Date,
): Promise<BalanceSheetCashBasis> {
  // 1. Fetch the accrual Balance Sheet (source of truth — do NOT re-query the GL directly).
  const accrual = await balanceSheet(ctx, asOf);
  const meta = new Map(
    (
      await ctx.db
        .select({ id: accounts.id, code: accounts.code, name: accounts.name, subtype: accounts.subtype })
        .from(accounts)
        .where(eq(accounts.companyId, ctx.companyId))
    ).map((a) => [a.id, a]),
  );
  const describe = (l: ReportLine) => meta.get(l.accountId) ?? { code: l.code, name: l.name, subtype: '' };

  // 2. Separate AR lines from the rest of the assets.
  const removedArLines: RemovedLine[] = [];
  const cashAssets: ReportLine[] = [];
  let arRemoved = Money.zero();

  for (const line of accrual.assets) {
    if (isReceivable(describe(line))) {
      removedArLines.push({ accountId: line.accountId, code: line.code, name: line.name, amount: line.amount });
      arRemoved = arRemoved.plus(Money.of(line.amount));
    } else {
      cashAssets.push(line);
    }
  }

  // 3. Separate AP lines from the rest of the liabilities.
  const removedApLines: RemovedLine[] = [];
  const cashLiabilities: ReportLine[] = [];
  let apRemoved = Money.zero();

  for (const line of accrual.liabilities) {
    if (isPayable(describe(line))) {
      removedApLines.push({ accountId: line.accountId, code: line.code, name: line.name, amount: line.amount });
      apRemoved = apRemoved.plus(Money.of(line.amount));
    } else {
      cashLiabilities.push(line);
    }
  }

  // 4. Compute adjusted totals.
  //    totalAssets'      = totalAssets      − arRemoved
  //    totalLiabilities' = totalLiabilities − apRemoved
  //    equityAdjustment  = arRemoved − apRemoved   (always reduces equity on a net-AR basis)
  //    totalEquity'      = totalEquity      − equityAdjustment
  const totalAssets = Money.sub(accrual.totalAssets, arRemoved);
  const totalLiabilities = Money.sub(accrual.totalLiabilities, apRemoved);
  const equityAdjustment = arRemoved.minus(apRemoved);
  const totalEquity = Money.sub(accrual.totalEquity, equityAdjustment);
  const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity);
  const retainedEarnings = Money.sub(accrual.retainedEarnings, equityAdjustment);

  // Unreachable: the plug above is derived from the removed ledger balances themselves.
  assertBalanceSheetBalanced('Cash-basis balance sheet', totalAssets, totalLiabilities, totalEquity);
  const balanced = Money.eq(totalAssets, totalLiabilitiesAndEquity);

  return {
    basis: 'cash',
    assets: cashAssets,
    liabilities: cashLiabilities,
    equity: accrual.equity,
    retainedEarnings: toAmountString(retainedEarnings),
    accrualRetainedEarnings: accrual.retainedEarnings,
    totals: {
      totalAssets: toAmountString(totalAssets),
      totalLiabilities: toAmountString(totalLiabilities),
      totalEquity: toAmountString(totalEquity),
      totalLiabilitiesAndEquity: toAmountString(totalLiabilitiesAndEquity),
    },
    balanced,
    asOf: accrual.asOf,
    adjustments: {
      arRemoved: toAmountString(arRemoved),
      apRemoved: toAmountString(apRemoved),
      equityAdjustment: toAmountString(equityAdjustment),
      removedArLines,
      removedApLines,
    },
  };
}
