import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Sales by Customer Summary — runs on the standard report engine (lib/reports/catalog.ts key "sales-by-customer-summary"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/sales-by-customer');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="sales-by-customer-summary" />
    </Suspense>
  );
}
