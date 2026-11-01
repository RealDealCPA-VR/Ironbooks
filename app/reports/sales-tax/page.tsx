import { redirect } from 'next/navigation';
import { getPageContext } from '@/lib/context';
import { type SalesTaxFrequency, lastFilingPeriod } from '@/lib/services/accountant/salesTaxLedger';
import { getPreferences } from '@/lib/services/company';
import { todayInTimeZone } from '@/lib/preferences';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Sales Tax reports now run on the standard report engine — Sales Tax Liability (with each
 * agency's tax components) and the Sales Tax Revenue Summary — so they can be memorized,
 * scheduled, filtered and number-formatted. Old links (?view=revenue, ?from, ?to, ?basis) open
 * the same report, defaulting to the company's sales tax basis and its last filing period (QB).
 */
export default async function SalesTaxReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; basis?: string; view?: string }>;
}) {
  const ctx = await getPageContext('/reports/sales-tax');
  const p = await searchParams;
  const prefs = await getPreferences(ctx);
  // The last complete period before today on the company's calendar (not the UTC day).
  const period = lastFilingPeriod(prefs.salesTaxFrequency as SalesTaxFrequency, todayInTimeZone(prefs.timezone));
  const fromStr = p.from && DAY.test(p.from) ? p.from : period.from;
  const toStr = p.to && DAY.test(p.to) ? p.to : period.to;
  const basis = p.basis === 'cash' || p.basis === 'accrual' ? p.basis : prefs.salesTaxBasis === 'cash' ? 'cash' : 'accrual';
  if (p.view === 'revenue') redirect(`/reports/std/sales-tax-revenue-summary?from=${fromStr}&to=${toStr}&basis=${basis}`);
  redirect(`/reports/std/sales-tax-liability?from=${fromStr}&to=${toStr}&basis=${basis}`);
}
