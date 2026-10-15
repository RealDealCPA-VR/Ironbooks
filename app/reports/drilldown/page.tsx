import { Suspense } from 'react';
import { getPageContext } from '@/lib/context';
import DrilldownView from '../_components/DrilldownView';

export const dynamic = 'force-dynamic';

/**
 * QuickZoom: the transactions behind one report number. Reached by clicking (or pressing Enter
 * on) any amount of a standard report; the report, line, column and options are in the URL.
 */
export default async function Page() {
  await getPageContext('/reports/drilldown');
  return (
    <Suspense fallback={null}>
      <DrilldownView />
    </Suspense>
  );
}
