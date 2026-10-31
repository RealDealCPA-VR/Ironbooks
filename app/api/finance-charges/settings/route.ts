/**
 * GET /api/finance-charges/settings — current finance-charge settings.
 * PUT /api/finance-charges/settings — update { annualRate?, minCharge?, graceDays?, accountId?,
 *   assessOnFinanceCharges?, calculateFrom?: 'due_date' | 'invoice_date', markToBePrinted? }.
 *
 * Stored in companies.settings.financeCharges (jsonb).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  getFinanceChargeSettings,
  updateFinanceChargeSettings,
} from '@/lib/services/financeCharges';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[finance-charges/settings] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const settings = await getFinanceChargeSettings(ctx);
    return NextResponse.json(settings);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await requireJsonObject(req, { optional: true });
    const ctx = await getServerContext();
    // prefsperms A2 (Preferences > Finance Charge): account, compounding, "calculate from" and
    // "mark To be printed" too.
    if (body.accountId !== undefined && body.accountId !== null && typeof body.accountId !== 'string') {
      throw new ServiceError('VALIDATION', 'accountId must be an account id or null.');
    }
    for (const k of ['assessOnFinanceCharges', 'markToBePrinted'] as const) {
      if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new ServiceError('VALIDATION', `${k} must be true or false.`);
    }
    if (body.calculateFrom !== undefined && body.calculateFrom !== 'due_date' && body.calculateFrom !== 'invoice_date') {
      throw new ServiceError('VALIDATION', 'calculateFrom must be due_date or invoice_date.');
    }
    const settings = await updateFinanceChargeSettings(ctx, {
      annualRate: body.annualRate !== undefined ? String(body.annualRate) : undefined,
      minCharge: body.minCharge !== undefined ? String(body.minCharge) : undefined,
      graceDays: body.graceDays !== undefined ? Number(body.graceDays) : undefined,
      ...(body.accountId !== undefined ? { accountId: (body.accountId as string | null) || null } : {}),
      ...(body.assessOnFinanceCharges !== undefined ? { assessOnFinanceCharges: body.assessOnFinanceCharges as boolean } : {}),
      ...(body.calculateFrom !== undefined ? { calculateFrom: body.calculateFrom as 'due_date' | 'invoice_date' } : {}),
      ...(body.markToBePrinted !== undefined ? { markToBePrinted: body.markToBePrinted as boolean } : {}),
    });
    return NextResponse.json(settings);
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH alias — lib/client's api helper exposes patch (no put). */
export const PATCH = PUT;
