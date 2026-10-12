/**
 * Cash-Basis Balance Sheet (QuickBooks Desktop "Report Basis: Cash").
 *
 * Built from the posted ledger plus the cash-basis adjustments of cashBasisLedger.ts: every
 * income / expense line of an A/R or A/P document that is not yet paid is moved off earnings and
 * onto that document's own A/R or A/P account, and moved back in proportion as the document is
 * settled. Every adjustment is a balanced pair, so:
 *   - the sheet balances by construction (re-asserted below — never plugged);
 *   - cash-basis earnings (Retained Earnings + Net Income) equal cash-basis net income to date;
 *   - A/R and A/P keep only the balance-sheet share of open documents (sales tax, inventory,
 *     retainage held back) and journal-entry amounts, as on QuickBooks' cash-basis balance sheet,
 *     so a $108 unpaid invoice with $8 tax shows $8 of A/R and $8 of Sales Tax Payable.
 * Prior-year earnings and current-year Net Income are split at the fiscal-year start like the
 * accrual sheet.
 */
import { eq } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { accounts } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { assertBalanceSheetBalanced } from './ledgerAssert';
import { balanceSheet, type BalanceSheet, type ReportLine } from './reports';
import { cashBasisLedger } from './cashBasisLedger';

export interface AdjustedLine {
  accountId: string;
  code: string;
  name: string;
  accrualAmount: string;
  cashAmount: string;
}

/** The cash-basis Balance Sheet returned by balanceSheetCashBasis. */
export interface BalanceSheetCashBasis {
  basis: 'cash';
  assets: ReportLine[];
  liabilities: ReportLine[];
  /** Equity accounts (unchanged by the cash conversion). */
  equity: ReportLine[];
  /** Cash-basis earnings to date (= priorYearsEarnings + currentYearNetIncome). */
  retainedEarnings: string;
  priorYearsEarnings: string;
  currentYearNetIncome: string;
  /** The accrual-basis figure, for reference. */
  accrualRetainedEarnings: string;
  totals: {
    totalAssets: string;
    totalLiabilities: string;
    totalEquity: string;
    totalLiabilitiesAndEquity: string;
  };
  /** True when totalAssets = totalLiabilities + totalEquity (exact; asserted). */
  balanced: boolean;
  asOf?: string;
  fiscalYearStart?: string;
  adjustments: {
    /** Accrual A/R − cash A/R (income on unpaid customer documents). */
    arAdjustment: string;
    /** Accrual A/P − cash A/P (expenses on unpaid vendor documents). */
    apAdjustment: string;
    /** Accrual earnings − cash earnings. */
    equityAdjustment: string;
    adjustedLines: AdjustedLine[];
  };
}

/**
 * Cash-basis balance sheet in the same shape as the accrual balanceSheet() (so the standard
 * report engine can lay it out with QB sections, sub-accounts and the RE / Net Income split).
 */
export async function cashBasisBalanceSheet(ctx: ServiceContext, asOf?: Date): Promise<BalanceSheet> {
  return (await build(ctx, asOf)).bs;
}

async function build(ctx: ServiceContext, asOf?: Date) {
  const accrual = await balanceSheet(ctx, asOf);
  const fyStart = accrual.fiscalYearStart ? new Date(accrual.fiscalYearStart) : new Date(0);
  const { adjustments } = await cashBasisLedger(ctx, { to: asOf });
  const meta = new Map(
    (
      await ctx.db
        .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
        .from(accounts)
        .where(eq(accounts.companyId, ctx.companyId))
    ).map((a) => [a.id, { ...a, type: String(a.type) }]),
  );

  const perAccount = new Map<string, Decimal>();
  let earnings = Money.zero();
  let current = Money.zero();
  for (const a of adjustments) {
    if (asOf && a.date > asOf) continue;
    const t = meta.get(a.accountId)?.type;
    if (t === 'revenue' || t === 'expense') {
      earnings = earnings.minus(a.net); // earnings = credits − debits
      if (a.date >= fyStart) current = current.minus(a.net);
    } else {
      perAccount.set(a.accountId, (perAccount.get(a.accountId) ?? Money.zero()).plus(a.net));
    }
  }

  const adjustedLines: AdjustedLine[] = [];
  let dAssets = Money.zero();
  let dLiabilities = Money.zero();
  let dAr = Money.zero();
  let dAp = Money.zero();
  const apply = (group: ReportLine[], type: 'asset' | 'liability') => {
    const out = group.map((l) => ({ ...l }));
    for (const [id, net] of perAccount) {
      const m = meta.get(id);
      if (!m || m.type !== type || net.isZero()) continue;
      const delta = type === 'asset' ? net : net.negated();
      let line = out.find((l) => l.accountId === id);
      const before = line ? Money.of(line.amount) : Money.zero();
      if (!line) {
        line = { accountId: id, code: m.code, name: m.name, amount: '0.00' };
        out.push(line);
      }
      line.amount = toAmountString(before.plus(delta));
      adjustedLines.push({
        accountId: id,
        code: m.code,
        name: m.name,
        accrualAmount: toAmountString(before),
        cashAmount: line.amount,
      });
      if (type === 'asset') {
        dAssets = dAssets.plus(delta);
        dAr = dAr.minus(delta);
      } else {
        dLiabilities = dLiabilities.plus(delta);
        dAp = dAp.minus(delta);
      }
    }
    out.sort((a, b) => a.code.localeCompare(b.code));
    return out.filter((l) => !(Money.isZero(l.amount) && !group.some((g) => g.accountId === l.accountId)));
  };
  const assets = apply(accrual.assets, 'asset');
  const liabilities = apply(accrual.liabilities, 'liability');

  const totalAssets = Money.of(accrual.totalAssets).plus(dAssets);
  const totalLiabilities = Money.of(accrual.totalLiabilities).plus(dLiabilities);
  const totalEquity = Money.of(accrual.totalEquity).plus(earnings);
  // Unreachable while every adjustment is a balanced pair — throws INTEGRITY otherwise.
  assertBalanceSheetBalanced('Cash-basis balance sheet', totalAssets, totalLiabilities, totalEquity);

  const retained = Money.of(accrual.retainedEarnings).plus(earnings);
  const currentYear = Money.of(accrual.currentYearNetIncome).plus(current);
  const bs: BalanceSheet = {
    assets,
    liabilities,
    equity: accrual.equity,
    totalAssets: toAmountString(totalAssets),
    totalLiabilities: toAmountString(totalLiabilities),
    totalEquity: toAmountString(totalEquity),
    retainedEarnings: toAmountString(retained),
    priorYearsEarnings: toAmountString(retained.minus(currentYear)),
    currentYearNetIncome: toAmountString(currentYear),
    fiscalYearStart: accrual.fiscalYearStart,
    balanced: Money.eq(totalAssets, totalLiabilities.plus(totalEquity)),
    asOf: accrual.asOf,
  };
  return { bs, accrual, adjustedLines, dAr, dAp, earnings };
}

/**
 * Compute a cash-basis Balance Sheet as of an optional date (all posted activity when omitted).
 */
export async function balanceSheetCashBasis(ctx: ServiceContext, asOf?: Date): Promise<BalanceSheetCashBasis> {
  const { bs, accrual, adjustedLines, dAr, dAp, earnings } = await build(ctx, asOf);
  return {
    basis: 'cash',
    assets: bs.assets,
    liabilities: bs.liabilities,
    equity: bs.equity,
    retainedEarnings: bs.retainedEarnings,
    priorYearsEarnings: bs.priorYearsEarnings,
    currentYearNetIncome: bs.currentYearNetIncome,
    accrualRetainedEarnings: accrual.retainedEarnings,
    totals: {
      totalAssets: bs.totalAssets,
      totalLiabilities: bs.totalLiabilities,
      totalEquity: bs.totalEquity,
      totalLiabilitiesAndEquity: toAmountString(Money.add(bs.totalLiabilities, bs.totalEquity)),
    },
    balanced: bs.balanced,
    asOf: bs.asOf,
    fiscalYearStart: bs.fiscalYearStart,
    adjustments: {
      arAdjustment: toAmountString(dAr),
      apAdjustment: toAmountString(dAp),
      equityAdjustment: toAmountString(earnings.negated()),
      adjustedLines,
    },
  };
}
