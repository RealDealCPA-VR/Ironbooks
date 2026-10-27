/**
 * Sales Tax Liability on the standard report engine (QB Reports > Vendors & Payables > Sales Tax
 * Liability), so it can be memorized, scheduled, formatted and QuickZoomed. The figures come from
 * the GL-driven sales-tax ledger (accountant/salesTaxLedger.ts), the same numbers the Pay Sales Tax
 * screen uses; the Sales Tax page (/reports/sales-tax) keeps the component and revenue views.
 */
import { Money, toAmountString } from '@/lib/money';
import type { CellValue, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { salesTaxLiabilityReport } from './accountant/salesTaxLedger';
import { getPreferences } from './company';
import { dayStr, resolveRange, stdHref } from './reportEngine';
import { rangeLabel } from './reportsStandard';

export async function salesTaxLiabilityStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  // No basis chosen: the Sales Tax preference (accrual / cash) decides, as on Pay Sales Tax.
  const r = await salesTaxLiabilityReport(ctx, { from, to, basis: p.basis ?? ((await getPreferences(ctx)).salesTaxBasis === 'cash' ? 'cash' : 'accrual') });
  const basis = r.basis;
  const keys = ['openingBalance', 'collected', 'credited', 'adjustments', 'paid', 'balance'] as const;
  const cells = (label: string, a: Record<(typeof keys)[number], string> & { unattributed?: string }): Record<string, CellValue> => {
    const c: Record<string, CellValue> = { label };
    for (const k of keys) c[k] = toAmountString(Money.of(a[k] ?? '0'));
    // Unattributed liability activity is folded into Adjustments so the row adds up.
    if (a.unattributed && !Money.of(a.unattributed).isZero()) c.adjustments = toAmountString(Money.of(a.adjustments).plus(Money.of(a.unattributed)));
    return c;
  };
  const rows: StdRow[] = [];
  for (const a of r.agencies
    .filter((a) => keys.some((k) => !Money.of(a[k]).isZero()) || !Money.of(a.unattributed).isZero())
    .sort((a, b) => (a.agencyName ?? '~').localeCompare(b.agencyName ?? '~'))) {
    const id = `stl:${a.agencyId ?? 'none'}`;
    const comps = (a.components ?? []).filter((c) => !Money.of(c.collected).isZero() || !Money.of(c.credited).isZero());
    rows.push({
      id,
      depth: 0,
      kind: 'data' as const,
      cells: cells(a.agencyName ?? 'Not linked to an agency', a),
      href: a.liabilityAccountId
        ? stdHref('transaction-detail-by-account', { accountId: a.liabilityAccountId, from: dayStr(from), to: dayStr(to) })
        : stdHref('transaction-detail-by-account', { section: 'other_current_liability', from: dayStr(from), to: dayStr(to) }),
      ...(comps.length ? { collapsedCells: cells(a.agencyName ?? 'Not linked to an agency', a), collapseKind: 'group' as const } : {}),
    });
    // The agency's tax components (combined rates split over their agencies), as in QB.
    for (const c of comps) {
      rows.push({
        id: `${id}:c:${c.taxRateId ?? 'none'}:${c.componentName}`,
        parentId: id,
        depth: 1,
        kind: 'data' as const,
        cells: { label: c.componentName, collected: toAmountString(Money.of(c.collected)), credited: toAmountString(Money.of(c.credited)) },
      });
    }
  }
  rows.push({ id: 'stl:grand', depth: 0, kind: 'grand', cells: cells('TOTAL', r.totals) });
  return {
    key: 'sales-tax-liability',
    title: 'Sales Tax Liability',
    subtitle: `${rangeLabel(from, to)}${basis === 'cash' ? ' · Cash Basis' : ''}`,
    columns: [
      { key: 'label', header: 'Tax agency' },
      { key: 'openingBalance', header: 'Owed at start', type: 'money' },
      { key: 'collected', header: 'Tax Collected', type: 'money' },
      { key: 'credited', header: 'Tax Credited', type: 'money' },
      { key: 'adjustments', header: 'Adjustments', type: 'money' },
      { key: 'paid', header: 'Paid', type: 'money' },
      { key: 'balance', header: 'Sales Tax Payable', type: 'money' },
    ],
    rows,
    balanced: basis === 'accrual' ? r.tiesToGl : undefined,
    notes: [
      'Collected tax counts on the sale date on an accrual basis, and when the customer pays on a cash basis.',
      ...(basis === 'accrual' ? [`Sales Tax Payable is the balance of your sales tax liability accounts (${toAmountString(Money.of(r.glBalance))} on ${dayStr(to)}).`] : []),
      ...(!Money.of(r.totals.unattributed ?? '0').isZero() ? ['Some sales tax was recorded outside the sales tax screens. Use Fix Incorrectly Recorded Sales Tax to assign it to an agency.'] : []),
    ],
  };
}
