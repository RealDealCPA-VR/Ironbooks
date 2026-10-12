import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * A/P Aging Detail — runs on the standard report engine (lib/reports/catalog.ts key "ap-aging-detail"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/ap-aging-detail');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="ap-aging-detail" />
    </Suspense>
  );
}
