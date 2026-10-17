/**
 * GET  /api/items          — list items (query: includeInactive, type, search)
 * POST /api/items          — create a new item
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listItems, createItem } from '@/lib/services/items';
import { setReorderPoint } from '@/lib/services/inventory';
import { ServiceError } from '@/lib/services/_base';
import type { ItemType } from '@/lib/services/items';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createItemSchema } from '@/lib/validation/items';
import { createItemWithOpeningStock } from '@/lib/services/lists/openingStock';
import { requirePermission } from '@/lib/services/access';
import { serviceErrorStatus } from '@/lib/routeErrors';

// ── Error helper ──────────────────────────────────────────────────────────────

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

// ── GET /api/items ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;

    const opts = {
      includeInactive: sp.get('includeInactive') === 'true',
      type: (sp.get('type') as ItemType | null) ?? undefined,
      search: sp.get('search') ?? undefined,
    };

    const rows = await listItems(ctx, opts);
    return NextResponse.json({ items: rows });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/items]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST /api/items ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createItemSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const { reorderPoint, openingQuantity, openingValue, openingUnitCost, openingAsOf, openingCosting, ...input } = parsed.data;

    // Opening quantity on hand posts to the ledger (Inventory Asset vs Opening Balance Equity),
    // so it needs inventory rights on top of the list rights this route is mapped to.
    const hasOpening = openingQuantity != null && openingQuantity !== '' && Number(openingQuantity) !== 0;
    if (hasOpening) requirePermission(ctx, 'inventory', 'create');
    let item = hasOpening
      ? (await createItemWithOpeningStock(ctx, { ...input, openingQuantity, openingValue, openingUnitCost, openingAsOf, openingCosting })).item
      : await createItem(ctx, input);

    // Reorder point is managed by the inventory service (it drives the
    // reorder report and low-stock alerts) rather than the item master data.
    if (reorderPoint != null && reorderPoint !== '') {
      item = await setReorderPoint(ctx, item.id, reorderPoint);
    }

    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/items]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
