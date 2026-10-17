/**
 * GET  /api/landed-cost              — list allocations
 * GET  /api/landed-cost?sources=1    — bill charge lines available to allocate (?billId=)
 * POST /api/landed-cost              — allocate a bill charge onto item receipts
 *   body: { billId, billLineId, method: 'quantity'|'value'|'weight', itemReceiptIds: [...],
 *           amount?, date?, memo? }
 *   Posts Dr Inventory (units on hand) / Dr COGS (units sold) / Cr charge account per receipt
 *   line through postJournalEntry and raises the received units' cost.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  allocateLandedCost,
  listLandedCostAllocations,
  listLandedCostSources,
} from '@/lib/services/landedCost';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { landedCostSchema } from '@/lib/validation/inventorySites';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details },
      { status },
    );
  }
  console.error('[landed-cost/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    if (sp.get('sources') === '1') {
      return NextResponse.json(
        await listLandedCostSources(ctx, {
          billId: sp.get('billId'),
          includeFullyAllocated: sp.get('includeFullyAllocated') === '1',
        }),
      );
    }
    return NextResponse.json(await listLandedCostAllocations(ctx));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = landedCostSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await allocateLandedCost(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
