/**
 * GET    /api/items/:id    — fetch a single item
 * PATCH  /api/items/:id    — update an item (partial update)
 * DELETE /api/items/:id    — soft-delete (deactivate) an item
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getItem, updateItem, deactivateItem } from '@/lib/services/items';
import { setReorderPoint } from '@/lib/services/inventory';
import { ServiceError } from '@/lib/services/_base';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateItemSchema } from '@/lib/validation/items';

// ── Error helper ──────────────────────────────────────────────────────────────

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

// ── Route params type ─────────────────────────────────────────────────────────

interface RouteParams {
  params: Promise<{ id: string }>;
}

// ── GET /api/items/:id ────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const item = await getItem(ctx, id);
    return NextResponse.json({ item });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/items/:id]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PATCH /api/items/:id ──────────────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    // zod's strip mode keeps absent keys absent, so updateItem can distinguish
    // "not provided" from "explicitly set to null".
    const parsed = updateItemSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const { reorderPoint, ...patch } = parsed.data;

    // Multi-user: 409 if someone else saved this item since it was loaded.
    const item = await withVersionCheck(ctx, 'item', id, expectedVersion(req), async (c) => {
      let updated = await updateItem(c, id, patch);

      // Reorder point is managed by the inventory service (it drives the
      // reorder report and low-stock alerts). null / '' clears it.
      if ('reorderPoint' in parsed.data) {
        updated = await setReorderPoint(c, id, reorderPoint ?? null);
      }
      return updated;
    });

    return NextResponse.json({ item });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[PATCH /api/items/:id]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE /api/items/:id ─────────────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const item = await withVersionCheck(ctx, 'item', id, expectedVersion(req), (c) => deactivateItem(c, id));
    return NextResponse.json({ item });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[DELETE /api/items/:id]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
