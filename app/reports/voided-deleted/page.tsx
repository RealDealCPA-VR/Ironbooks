import { redirect } from 'next/navigation';
import { getPageContext } from '@/lib/context';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Voided/Deleted Transactions Summary and Detail now run on the standard report engine (filters,
 * QuickZoom, Fonts & Numbers, memorize, scheduling). Old links (?from, ?to, ?detail=1) open the
 * same report.
 */
export default async function VoidedDeletedPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; detail?: string }>;
}) {
  await getPageContext('/reports/voided-deleted');
  const p = await searchParams;
  const qs = new URLSearchParams();
  if (p.from && DAY.test(p.from)) qs.set('from', p.from);
  if (p.to && DAY.test(p.to)) qs.set('to', p.to);
  const s = qs.toString();
  redirect(`/reports/std/${p.detail === '1' ? 'voided-deleted-detail' : 'voided-deleted-summary'}${s ? `?${s}` : ''}`);
}
