/**
 * POST /api/year-end-close
 * Body: { fiscalYear: number }
 *
 * Runs the year-end closing process for the given fiscal year:
 *   - Aggregates all posted revenue and expense entries for the year.
 *   - Posts a single balanced closing journal entry that zeros out P&L
 *     accounts into Retained Earnings (code 3900).
 *
 * Returns the closing entry and summary figures on success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { yearEndClose } from '@/lib/services/fiscalClose';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[year-end-close] error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    const fiscalYear = Number(body.fiscalYear);
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2100) {
      return NextResponse.json(
        { error: 'fiscalYear must be a valid four-digit year (1900–2100).', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const result = await yearEndClose(ctx, { fiscalYear });

    return NextResponse.json(
      {
        entryId: result.entry.id,
        entryNumber: result.entry.entryNumber,
        description: result.entry.description,
        date: result.entry.date,
        netIncome: result.netIncome,
        totalRevenue: result.totalRevenue,
        totalExpenses: result.totalExpenses,
        retainedEarnings: result.retainedEarnings,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
