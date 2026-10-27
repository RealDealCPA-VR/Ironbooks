import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Closing Date Exception Report — runs on the standard report engine (lib/reports/catalog.ts key "closing-date-exceptions"): filters,
 * QuickZoom to the source form, Fonts & Numbers, memorize, report groups and scheduling. Settings
 * live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/closing-date-exceptions');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="closing-date-exceptions" />
    </Suspense>
  );
}
