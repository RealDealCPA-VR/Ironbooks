/**
 * POST /api/inventory/physical-count
 *
 * Body: { itemId: string, countedQty: string | number, date: string,
 *         adjustmentAccountId?: string, classId?, customerId?, jobId? }
 *
 * Records a physical inventory count. If countedQty differs from quantityOnHand,
 * posts a GL adjustment (Dr/Cr the Adjustment Account — default "Inventory Adjustments" —
 * vs Inventory Asset) and updates
 * the item's quantityOnHand to the counted value.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { physicalCount } from '@/lib/services/inventoryOps';
import { assertPhysicalCountable } from '@/lib/services/inventory';
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
    const body = await req.json() as {
      itemId?: string;
      countedQty?: string | number;
      date?: string;
      adjustmentAccountId?: string | null;
      classId?: string | null;
      customerId?: string | null;
      jobId?: string | null;
    };

    const { itemId, countedQty, date, adjustmentAccountId, classId, customerId, jobId } = body;

    if (!itemId) {
      return NextResponse.json({ error: 'itemId is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (countedQty == null || countedQty === '') {
      return NextResponse.json(
        { error: 'countedQty is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (!date) {
      return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
    }

    // physicalCount is an average-cost operation: reject non-inventory item
    // types and FIFO-tracked items (their stock lives in inventoryLayers and
    // must be counted through the FIFO endpoints) before posting anything.
    await assertPhysicalCountable(ctx, itemId);

    const result = await physicalCount(ctx, {
      itemId,
      countedQty,
      date: new Date(date),
      adjustmentAccountId: adjustmentAccountId ?? null,
      classId: classId ?? null,
      customerId: customerId ?? null,
      jobId: jobId ?? null,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/inventory/physical-count]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
