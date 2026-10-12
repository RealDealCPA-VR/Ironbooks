/**
 * GET /api/reports/pivot?rows=account&cols=month&measure=amount&source=gl&from=&to=&section=
 * Advanced Reporting-lite: ledger lines (or item sales) pivoted by two dimensions.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { pivotReport } from '@/lib/services/reportsAnalysis';
import { zodErrorBody } from '@/lib/validation/helpers';
import { pivotSchema } from '@/lib/validation/reports';
import { reportError } from '../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const raw = Object.fromEntries([...req.nextUrl.searchParams.entries()].filter(([, v]) => v !== ''));
    const parsed = pivotSchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await pivotReport(ctx, parsed.data));
  } catch (err) {
    return reportError(err, 'pivot');
  }
}
