import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * P&L % of Income — runs on the standard report engine (QB sections, sub-account roll-up with
 * collapse / expand, QuickZoom, filters, number formats, memorize). Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/pl-percent');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="profit-loss-percent" />
    </Suspense>
  );
}
