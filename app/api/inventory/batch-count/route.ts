/**
 * POST /api/inventory/batch-count
 *
 * Body: {
 *   date: string;
 *   counts: Array<{ itemId: string; countedQty: string | number }>;
 *   adjustmentAccountId?: string;   // default "Inventory Adjustments"
 *   classId?: string; customerId?: string; jobId?: string;
 * }
 *
 * Applies a whole physical count sheet at once. Each entry posts its own
 * shrinkage/overage adjustment via physicalCount; FIFO-tracked items (and any
 * other guard rejections) are returned in `skipped` with the reason rather
 * than failing the batch.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { batchPhysicalCount } from '@/lib/services/inventoryOps';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req)) as {
      date?: string;
      counts?: Array<{ itemId: string; countedQty: string | number }>;
      adjustmentAccountId?: string | null;
      classId?: string | null;
      customerId?: string | null;
      jobId?: string | null;
    };

    if (!body.date) {
      return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!Array.isArray(body.counts) || body.counts.length === 0) {
      return NextResponse.json(
        { error: 'counts must be a non-empty array', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const result = await batchPhysicalCount(ctx, {
      date: new Date(body.date),
      counts: body.counts,
      adjustmentAccountId: body.adjustmentAccountId ?? null,
      classId: body.classId ?? null,
      customerId: body.customerId ?? null,
      jobId: body.jobId ?? null,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/inventory/batch-count]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
