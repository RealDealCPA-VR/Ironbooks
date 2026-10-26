/**
 * GET  /api/inventory        — inventory valuation report
 * POST /api/inventory        — adjust inventory or record COGS
 *
 * POST body shapes:
 *   { action: 'adjust', itemId, quantityChange, unitCost?, date, memo?,
 *     adjustmentAccountId?, classId?, customerId?, jobId? }   (QB Adjust Quantity on Hand;
 *     the account defaults to "Inventory Adjustments")
 *   { action: 'cogs',   itemId, quantity, date, memo? }
 * Both run through adjustQuantityAtSite so the quantity change is recorded at a site (optional
 * { siteId?, binId?, serialNumbers?, lotNumber?, lotExpiration? }; default site otherwise) and
 * serial/lot rules are enforced. FIFO-tracked items are costed through their layers.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { inventoryDate, inventoryValuation } from '@/lib/services/inventory';
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

// ── GET /api/inventory ────────────────────────────────────────────────────────

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const valuation = await inventoryValuation(ctx);
    return NextResponse.json(valuation);
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/inventory]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST /api/inventory ───────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { action } = body as { action?: string };

    if (!action) {
      return NextResponse.json(
        { error: 'action is required: "adjust" or "cogs"', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    if (action === 'adjust') {
      const { itemId, quantityChange, unitCost, date, memo } = body as {
        itemId: string;
        quantityChange: string | number;
        unitCost?: string | number | null;
        date: string;
        memo?: string | null;
      };

      if (!itemId) {
        return NextResponse.json({ error: 'itemId is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (quantityChange == null) {
        return NextResponse.json(
          { error: 'quantityChange is required', code: 'VALIDATION' },
          { status: 400 },
        );
      }
      if (!date) {
        return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
      }

      const result = await adjustQuantityAtSite(ctx, {
        ...siteFields(body),
        itemId,
        quantityChange,
        unitCost: unitCost ?? null,
        date: inventoryDate(date),
        memo: memo ?? null,
      });

      return NextResponse.json(result, { status: 201 });
    }

    if (action === 'cogs') {
      const { itemId, quantity, date, memo } = body as {
        itemId: string;
        quantity: string | number;
        date: string;
        memo?: string | null;
      };

      if (!itemId) {
        return NextResponse.json({ error: 'itemId is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (quantity == null) {
        return NextResponse.json(
          { error: 'quantity is required', code: 'VALIDATION' },
          { status: 400 },
        );
      }
      if (!date) {
        return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
      }

      // COGS relief = a removal valued at cost (Dr COGS / Cr Inventory).
      const result = await adjustQuantityAtSite(ctx, {
        ...siteFields(body),
        itemId,
        quantityChange: `-${String(quantity).replace(/^-/, '')}`,
        date: inventoryDate(date),
        memo: memo ?? 'Cost of goods sold',
        purpose: 'cogs',
      });

      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json(
      { error: `Unknown action "${action}". Use "adjust" or "cogs".`, code: 'VALIDATION' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/inventory]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
