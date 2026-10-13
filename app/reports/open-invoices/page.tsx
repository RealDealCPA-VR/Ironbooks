import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Open Invoices — runs on the standard report engine (lib/reports/catalog.ts key "open-invoices"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/open-invoices');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="open-invoices" />
    </Suspense>
  );
}
