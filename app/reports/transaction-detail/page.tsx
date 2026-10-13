import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Transaction Detail — the standard Transaction Detail by Account (filters for account, name,
 * type, amount, cleared, class, memo and number; sort and total-by; QuickZoom; memorize).
 */
export default async function Page() {
  await getPageContext('/reports/transaction-detail');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="transaction-detail-by-account" />
    </Suspense>
  );
}
