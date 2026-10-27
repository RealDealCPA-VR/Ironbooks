import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Sales by Rep Summary — runs on the standard report engine (lib/reports/catalog.ts key "sales-by-rep-summary"): filters,
 * QuickZoom to the source form, Fonts & Numbers, memorize, report groups and scheduling. Settings
 * live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/sales-by-rep');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="sales-by-rep-summary" />
    </Suspense>
  );
}
