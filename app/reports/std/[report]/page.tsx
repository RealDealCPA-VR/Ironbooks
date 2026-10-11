import { Suspense } from 'react';
import StdReportView from '../../_components/StdReportView';

/** Any standard report from the catalog (lib/reports/catalog.ts): /reports/std/<key>?<settings>. */
export default async function StandardReportPage({ params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  return (
    <Suspense fallback={null}>
      <StdReportView reportKey={report} />
    </Suspense>
  );
}
