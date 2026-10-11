/**
 * GET  /api/payroll/adjustments[?employeeId=&includeVoided=true]
 *        — historical YTD amounts and payroll liability adjustments.
 * POST /api/payroll/adjustments
 *        { type: 'ytd', employeeId, date, lines[], affectsAccounts?, bankAccountId? }
 *          — mid-year setup: historical paychecks / quarter summaries (default: does NOT post
 *            to the GL, because a General Ledger import already holds these amounts).
 *        { type: 'liability', employeeId, date, lines[], affectsAccounts?, offsetAccountId? }
 *          — Adjust Payroll Liabilities (signed amounts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  createLiabilityAdjustment,
  createYtdAdjustment,
  listPayrollAdjustments,
} from '@/lib/services/payrollAdjustments';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createAdjustmentSchema } from '@/lib/validation/payroll';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await listPayrollAdjustments(ctx, {
        employeeId: sp.get('employeeId') ?? undefined,
        includeVoided: sp.get('includeVoided') === 'true',
      }),
    );
  } catch (err) {
    return routeError(err, 'payroll/adjustments');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createAdjustmentSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const d = parsed.data;
    const row = d.type === 'ytd' ? await createYtdAdjustment(ctx, d) : await createLiabilityAdjustment(ctx, d);
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return routeError(err, 'payroll/adjustments');
  }
}
