import { redirect } from 'next/navigation';
import { getPageContext } from '@/lib/context';
import { safeBackHref } from '@/lib/reports/drilldown';
import { sourceFormForEntry } from '@/lib/services/sourceForms';
import OpenEntryView from './OpenEntryView';

export const dynamic = 'force-dynamic';

/**
 * QuickZoom from a report's detail line (/reports/open?entry=<journal entry id>&back=<report>):
 * opens the SOURCE FORM the transaction came from — the invoice, bill, check, deposit, payment…
 * (lib/services/sourceForms.ts). An entry with no form of its own (a reversal, an imported
 * QuickBooks GL entry) is shown as the transaction itself, with Back to the report.
 */
export default async function OpenSourceFormPage({ searchParams }: { searchParams: Promise<{ entry?: string; back?: string }> }) {
  const ctx = await getPageContext('/reports/open');
  const p = await searchParams;
  const entry = typeof p.entry === 'string' ? p.entry : '';
  const href = await sourceFormForEntry(ctx, entry);
  if (href) redirect(href);
  return <OpenEntryView entryId={/^[0-9a-f-]{36}$/i.test(entry) ? entry : null} back={safeBackHref(p.back) ?? '/reports'} />;
}
