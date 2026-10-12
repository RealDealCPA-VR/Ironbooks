import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Profit & Loss on a cash basis — the standard Profit & Loss (QB sections, sub-accounts,
 * QuickZoom, filters, memorize) run with basis=cash: income and expenses on invoices and bills
 * count when they are paid, in proportion to the amount paid (lib/services/cashBasisLedger.ts).
 */
export default async function Page() {
  await getPageContext('/reports/profit-loss-cash');
  return (
    <Suspense fallback={null}>
      <StdReportView
        reportKey="profit-loss"
        basis="cash"
        basisNav={{ value: 'cash', accrualHref: '/reports/profit-loss', cashHref: '/reports/profit-loss-cash' }}
      />
    </Suspense>
  );
}
