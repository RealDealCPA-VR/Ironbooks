import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Deposit Detail — runs on the standard report engine (lib/reports/catalog.ts key "deposit-detail"): filters,
 * QuickZoom to the source form, Fonts & Numbers, memorize, report groups and scheduling. Settings
 * live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/deposit-detail');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="deposit-detail" />
    </Suspense>
  );
}
