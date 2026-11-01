import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Payroll Summary (and the other payroll reports) — runs on the standard report engine (lib/reports/catalog.ts key "payroll-summary"): filters,
 * QuickZoom to the source form, Fonts & Numbers, memorize, report groups and scheduling. Settings
 * live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/payroll-summary');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="payroll-summary" />
    </Suspense>
  );
}
