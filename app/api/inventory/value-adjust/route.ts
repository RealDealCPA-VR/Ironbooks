/**
 * POST /api/inventory/value-adjust
 *
 * Body: {
 *   itemId: string;
 *   newTotalValue?: string | number;   // exactly one of newTotalValue / newUnitCost
 *   newUnitCost?: string | number;
 *   date: string;
 *   reason?: string;
 *   adjustmentAccountId?: string;   // default "Inventory Adjustments"
 *   classId?: string; customerId?: string; jobId?: string;
 * }
 *
 * Inventory value adjustment (revaluation). Posts Dr/Cr Inventory Asset vs the
 * Adjustment Account (default "Inventory Adjustments"); updates
 * averageCost for average-cost items or revalues remaining FIFO layers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { adjustInventoryValue } from '@/lib/services/inventoryOps';
import { ServiceError } from '@/lib/services/_base';

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const statusMap: Record<string, number> = {
    NOT_FOUND: 404,
    VALIDATION: 400,
    UNBALANCED: 400,
    FORBIDDEN: 403,
    CONFLICT: 409,
    PERIOD_CLOSED: 409,
  };
  const status = statusMap[err.code] ?? 500;
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = (await req.json()) as {
      itemId?: string;
      newTotalValue?: string | number | null;
      newUnitCost?: string | number | null;
      date?: string;
      reason?: string | null;
      adjustmentAccountId?: string | null;
      classId?: string | null;
      customerId?: string | null;
      jobId?: string | null;
    };

    if (!body.itemId) {
      return NextResponse.json({ error: 'itemId is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!body.date) {
      return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
    }

    const result = await adjustInventoryValue(ctx, {
      itemId: body.itemId,
      newTotalValue: body.newTotalValue ?? null,
      newUnitCost: body.newUnitCost ?? null,
      date: new Date(body.date),
      reason: body.reason ?? null,
      adjustmentAccountId: body.adjustmentAccountId ?? null,
      classId: body.classId ?? null,
      customerId: body.customerId ?? null,
      jobId: body.jobId ?? null,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/inventory/value-adjust]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
