import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import StdReportView from '../_components/StdReportView';

export const dynamic = 'force-dynamic';

/**
 * Quantity on Hand by Site (and the other inventory site reports) — runs on the standard report engine (lib/reports/catalog.ts key "quantity-on-hand-by-site"): filters,
 * QuickZoom to the source form, Fonts & Numbers, memorize, report groups and scheduling. Settings
 * live in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/inventory-sites');
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey="quantity-on-hand-by-site" />
    </Suspense>
  );
}
