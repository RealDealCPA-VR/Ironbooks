import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Collections Report — runs on the standard report engine (lib/reports/catalog.ts key "collections-report"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/collections');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="collections-report" />
    </Suspense>
  );
}
