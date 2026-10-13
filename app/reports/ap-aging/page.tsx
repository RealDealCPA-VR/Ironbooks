import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * A/P Aging Summary — runs on the standard report engine (lib/reports/catalog.ts key "ap-aging-summary"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/ap-aging');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="ap-aging-summary" />
    </Suspense>
  );
}
