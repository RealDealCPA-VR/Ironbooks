/**
 * GET  /api/fifo  — FIFO inventory valuation (all items, per-layer breakdown)
 * POST /api/fifo  — receive or consume stock using FIFO cost layers
 *
 * POST body shapes:
 *   { action: 'receive', itemId, quantity, unitCost, date, memo? }
 *   { action: 'consume', itemId, quantity, date, memo? }
 * Both accept optional Advanced Inventory fields { siteId?, binId?, serialNumbers?, lotNumber?,
 * lotExpiration? } and run through adjustQuantityAtSite (costing 'fifo'), so the movement is
 * recorded at the right site and serial/lot rules are enforced.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { fifoValuation } from '@/lib/services/fifo';
import { inventoryDate } from '@/lib/services/inventory';
import { adjustQuantityAtSite } from '@/lib/services/inventorySiteOps';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

// ── Error helper ──────────────────────────────────────────────────────────────

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

/** Optional Advanced Inventory fields from the raw body. */
function siteFields(body: Record<string, unknown>) {
  return {
    siteId: typeof body.siteId === 'string' ? body.siteId : null,
    binId: typeof body.binId === 'string' ? body.binId : null,
    serialNumbers: Array.isArray(body.serialNumbers) ? body.serialNumbers.map(String) : null,
    lotNumber: typeof body.lotNumber === 'string' ? body.lotNumber : null,
    lotExpiration: typeof body.lotExpiration === 'string' && body.lotExpiration ? inventoryDate(body.lotExpiration, 'lotExpiration') : null,
    // p1 purchases: QB Adjustment Account, Class and Customer:Job.
    adjustmentAccountId: typeof body.adjustmentAccountId === 'string' && body.adjustmentAccountId ? body.adjustmentAccountId : null,
    classId: typeof body.classId === 'string' && body.classId ? body.classId : null,
    customerId: typeof body.customerId === 'string' && body.customerId ? body.customerId : null,
    jobId: typeof body.jobId === 'string' && body.jobId ? body.jobId : null,
  };
}

// ── GET /api/fifo ─────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const valuation = await fifoValuation(ctx);
    return NextResponse.json(valuation);
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/fifo]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST /api/fifo ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req) as Record<string, unknown>;
    const { action } = body;

    if (!action) {
      return NextResponse.json(
        { error: 'action is required: "receive" or "consume"', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    if (action === 'receive') {
      const { itemId, quantity, unitCost, date, memo } = body as {
        itemId?: string;
        quantity?: string | number;
        unitCost?: string | number;
        date?: string;
        memo?: string | null;
      };

      if (!itemId) {
        return NextResponse.json({ error: 'itemId is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (quantity == null) {
        return NextResponse.json({ error: 'quantity is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (unitCost == null) {
        return NextResponse.json({ error: 'unitCost is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (!date) {
        return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
      }

      const result = await adjustQuantityAtSite(ctx, {
        ...siteFields(body),
        itemId,
        quantityChange: quantity,
        unitCost,
        date: inventoryDate(date),
        memo: memo ?? null,
        costing: 'fifo',
      });

      return NextResponse.json(result, { status: 201 });
    }

    if (action === 'consume') {
      const { itemId, quantity, date, memo } = body as {
        itemId?: string;
        quantity?: string | number;
        date?: string;
        memo?: string | null;
      };

      if (!itemId) {
        return NextResponse.json({ error: 'itemId is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (quantity == null) {
        return NextResponse.json({ error: 'quantity is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (!date) {
        return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
      }

      const result = await adjustQuantityAtSite(ctx, {
        ...siteFields(body),
        itemId,
        quantityChange: `-${String(quantity).replace(/^-/, '')}`,
        date: inventoryDate(date),
        memo: memo ?? null,
        costing: 'fifo',
        purpose: 'cogs',
      });

      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json(
      { error: `Unknown action "${action}". Use "receive" or "consume".`, code: 'VALIDATION' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/fifo]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
