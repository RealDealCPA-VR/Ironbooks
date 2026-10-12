import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Balance Sheet on a cash basis — the standard Balance Sheet (QB sections, sub-accounts, Retained
 * Earnings / Net Income split, QuickZoom, memorize) run with basis=cash. Income and expenses on
 * unpaid invoices and bills are left out of earnings and out of A/R and A/P; the sales tax,
 * inventory or retainage share of an open document stays in A/R or A/P, as in QuickBooks.
 */
export default async function Page() {
  await getPageContext('/reports/balance-sheet-cash');
  return (
    <Suspense fallback={null}>
      <StdReportView
        reportKey="balance-sheet"
        basis="cash"
        basisNav={{ value: 'cash', accrualHref: '/reports/balance-sheet', cashHref: '/reports/balance-sheet-cash' }}
      />
    </Suspense>
  );
}
