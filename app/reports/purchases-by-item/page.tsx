import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Purchases by Item Summary — runs on the standard report engine (lib/reports/catalog.ts key "purchases-by-item-summary"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/purchases-by-item');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="purchases-by-item-summary" />
    </Suspense>
  );
}
