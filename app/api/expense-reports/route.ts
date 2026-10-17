/**
 * GET  /api/expense-reports  — list expense reports for the active company.
 * POST /api/expense-reports  — create a new expense report (draft).
 *
 * POST body:
 *   { employeeId, title?, lines: [{ accountId, date?, description?, amount }] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createReport, listReports } from '@/lib/services/expenseReports';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject, assertStringFields } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[expense-reports] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(_req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const list = await listReports(ctx);
    return NextResponse.json(list);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    assertStringFields(body, ['title']);
    // Every line must be an object (a null / number line used to throw a TypeError → 500).
    if (Array.isArray(body.lines) && body.lines.some((l: unknown) => !l || typeof l !== 'object' || Array.isArray(l))) {
      return NextResponse.json({ error: 'Each expense line must be an object.', code: 'VALIDATION' }, { status: 400 });
    }
    if (Array.isArray(body.lines) && body.lines.some((l: Record<string, unknown>) => l.date && Number.isNaN(new Date(l.date as string).getTime()))) {
      return NextResponse.json({ error: 'An expense line date is not a valid date.', code: 'VALIDATION' }, { status: 400 });
    }

    const lines = Array.isArray(body.lines)
      ? body.lines.map((l: Record<string, unknown>) => ({
          accountId: l.accountId as string,
          date: l.date ? new Date(l.date as string) : null,
          description: (l.description as string | null | undefined) ?? null,
          amount: l.amount as string | number,
        }))
      : [];

    const report = await createReport(ctx, {
      employeeId: body.employeeId,
      title: body.title ?? null,
      lines,
    });
    return NextResponse.json(report, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
