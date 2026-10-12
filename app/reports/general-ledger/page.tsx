import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * General Ledger — runs on the standard report engine (lib/reports/catalog.ts key "general-ledger"): filters,
 * QuickZoom, Fonts & Numbers, memorize and scheduling. Settings live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/general-ledger');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="general-ledger" />
    </Suspense>
  );
}
