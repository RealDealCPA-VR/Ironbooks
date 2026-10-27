import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Missing Checks — runs on the standard report engine (lib/reports/catalog.ts key "missing-checks"): filters,
 * QuickZoom to the source form, Fonts & Numbers, memorize, report groups and scheduling. Settings
 * live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/missing-checks');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="missing-checks" />
    </Suspense>
  );
}
