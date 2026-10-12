/**
 * GET  /api/payroll/state-settings — employer state payroll tax settings (SUI/SDI by state+year).
 * POST /api/payroll/state-settings — create or replace one { state, year, suiRate, suiWageBase,
 *                                    sdiRate, sdiWageBase, accountNumber } (rates are fractions).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listStateTaxSettings, upsertStateTaxSetting } from '@/lib/services/payrollAdjustments';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { stateTaxSettingSchema } from '@/lib/validation/payroll';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listStateTaxSettings(ctx));
  } catch (err) {
    return routeError(err, 'payroll/state-settings');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = stateTaxSettingSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await upsertStateTaxSetting(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'payroll/state-settings');
  }
}
