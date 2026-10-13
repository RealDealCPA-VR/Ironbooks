import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Statement of Cash Flows — runs on the standard report engine (lib/reports/catalog.ts key "statement-of-cash-flows"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/cash-flow');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="statement-of-cash-flows" />
    </Suspense>
  );
}
