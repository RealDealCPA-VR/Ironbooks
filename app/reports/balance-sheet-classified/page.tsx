import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Balance Sheet (current and long-term sections) — runs on the standard report engine (lib/reports/catalog.ts key "balance-sheet"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/balance-sheet-classified');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="balance-sheet" />
    </Suspense>
  );
}
