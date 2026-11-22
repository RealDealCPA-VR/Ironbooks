/**
 * GET  /api/expense-reports/[id]              — get report with lines.
 * POST /api/expense-reports/[id]              — perform an action on the report.
 *
 * POST body:
 *   { action: 'submit' }     — transition draft → submitted
 *   { action: 'reimburse', bankAccountId? }  — transition submitted → reimbursed + post GL
 *                                             (paid from bankAccountId, else the default checking account)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getReport, submitReport, approveAndReimburse } from '@/lib/services/expenseReports';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';
import { bodyValidationError } from '@/lib/validation/helpers';
import { expenseReportActionSchema } from '@/lib/validation/expenseReports';

/**
 * The POST body as agents read it described (lib/validation/expenseReports.ts). Called once the
 * action is known, so it refuses nothing the handler let through.
 */
function checkActionBody(body: unknown): void {
  const checked = expenseReportActionSchema.safeParse(body);
  if (!checked.success) throw bodyValidationError(checked.error);
}

function errorResponse(err: unknown, prefix = 'expense-reports') {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error(`[${prefix}] unexpected error:`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const report = await getReport(ctx, id);
    return NextResponse.json(report);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const action = body?.action;

    if (action === 'submit') {
      checkActionBody(body);
      const updated = await submitReport(ctx, id);
      return NextResponse.json(updated);
    }

    if (action === 'reimburse') {
      checkActionBody(body);
      const bankAccountId = typeof body.bankAccountId === 'string' && body.bankAccountId ? body.bankAccountId : null;
      const updated = await approveAndReimburse(ctx, id, { bankAccountId });
      return NextResponse.json(updated);
    }

    return NextResponse.json(
      { error: `Unknown action "${action}". Valid actions: submit, reimburse.`, code: 'VALIDATION' },
      { status: 400 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
