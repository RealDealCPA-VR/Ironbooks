/**
 * GET /api/why-changed?since=<ISO>&preset=assets|liabilities|equity|income|expenses|net_income|all
 *                     &accounts=<id,id>&subaccounts=1&from=YYYY-MM-DD&to=YYYY-MM-DD&fytd=1
 *
 * "Why did this number change?": the transactions created, edited, voided or deleted since
 * `since` that moved a report total or an account balance, with before / after / who / when
 * (lib/services/whyChanged.ts).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { whyChanged, type WhyPreset } from '@/lib/services/whyChanged';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const accounts = (sp.get('accounts') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const result = await whyChanged(ctx, {
      since: new Date(sp.get('since') ?? ''),
      preset: (sp.get('preset') || undefined) as WhyPreset | undefined,
      accountIds: accounts.length ? accounts : undefined,
      includeSubaccounts: sp.get('subaccounts') === '1',
      from: sp.get('from') || null,
      to: sp.get('to') || null,
      fiscalYearToDate: sp.get('fytd') === '1',
    });
    return NextResponse.json(result);
  } catch (err) {
    return routeError(err, 'GET /api/why-changed');
  }
}
