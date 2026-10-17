/**
 * POST /api/assemblies/build
 *
 * Body: { assemblyItemId: string; quantity: string | number; action: 'build' | 'unbuild',
 *         siteId?, binId?, serialNumbers?, lotNumber?, lotExpiration?, components?, date? }
 * The optional Advanced Inventory fields pick the site the build happens at (components are
 * drawn from it, finished goods land in it) and the bins / serials / lots involved.
 *
 * Builds or unbuilds the specified quantity of an assembly item.
 * No GL entry is posted — both sides of the transaction are account 1300 (net $0).
 * Quantities and averageCost are updated on the item records directly.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { buildAssembly, unbuildAssembly } from '@/lib/services/assemblies';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { buildSiteFieldsSchema } from '@/lib/validation/inventorySites';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

// ── Error helper ──────────────────────────────────────────────────────────────

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

// ── POST /api/assemblies/build ────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req) as {
      assemblyItemId?: string;
      quantity?: string | number;
      action?: string;
    };

    const { assemblyItemId, quantity, action } = body;

    if (!assemblyItemId) {
      return NextResponse.json(
        { error: 'assemblyItemId is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (quantity == null) {
      return NextResponse.json(
        { error: 'quantity is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (action !== 'build' && action !== 'unbuild') {
      return NextResponse.json(
        { error: 'action must be "build" or "unbuild"', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const site = buildSiteFieldsSchema.safeParse(body);
    if (!site.success) return NextResponse.json(zodErrorBody(site.error), { status: 400 });

    if (action === 'build') {
      const result = await buildAssembly(ctx, { ...site.data, assemblyItemId, quantity });
      return NextResponse.json(result, { status: 201 });
    } else {
      const result = await unbuildAssembly(ctx, { ...site.data, assemblyItemId, quantity });
      return NextResponse.json(result, { status: 201 });
    }
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/assemblies/build]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
