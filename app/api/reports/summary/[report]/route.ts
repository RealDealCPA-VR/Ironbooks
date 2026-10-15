/**
 * GET /api/reports/summary/[report]?<report options>&vs=prior_period|prior_year&ai=1
 *
 * The one-line "what changed" summary for the top of a report (lib/services/reportSummary.ts):
 * deterministic numbers always; with ai=1 the sentence is phrased by the company's AI router
 * (local models by default, cloud only when the company opted in, redacted by the router).
 * Mapped 'member' like /api/reports/std: the service checks the report's own area (view).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { reportSummary } from '@/lib/services/reportSummary';
import { reportError } from '../../_lib';

export async function GET(req: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  try {
    const ctx = await getServerContext();
    const { report } = await params;
    const sp = req.nextUrl.searchParams;
    const result = await reportSummary(ctx, report, sp, {
      vs: sp.get('vs') === 'prior_year' ? 'prior_year' : 'prior_period',
      ai: sp.get('ai') === '1',
    });
    return NextResponse.json(result);
  } catch (err) {
    return reportError(err, 'summary');
  }
}
