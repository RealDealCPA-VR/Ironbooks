/**
 * GET  /api/payroll/workers-comp — workers' compensation class codes.
 * POST /api/payroll/workers-comp — add one { code, description?, ratePer100 }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createWorkersCompCode, listWorkersCompCodes } from '@/lib/services/payrollAdjustments';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { workersCompCodeSchema } from '@/lib/validation/payroll';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listWorkersCompCodes(ctx));
  } catch (err) {
    return routeError(err, 'payroll/workers-comp');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = workersCompCodeSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createWorkersCompCode(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'payroll/workers-comp');
  }
}
