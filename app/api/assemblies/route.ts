/**
 * GET   /api/assemblies?assemblyItemId=<id>  — fetch the BOM for an assembly
 * PUT   /api/assemblies                      — replace the BOM for an assembly
 * PATCH /api/assemblies                      — alias for PUT (used by client api.patch)
 *
 * Body: { assemblyItemId: string; components: { componentItemId: string; quantity: string }[] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getBom, setBom } from '@/lib/services/assemblies';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

// ── Error helper ──────────────────────────────────────────────────────────────

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

// ── GET /api/assemblies ───────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const assemblyItemId = req.nextUrl.searchParams.get('assemblyItemId');
    if (!assemblyItemId) {
      return NextResponse.json(
        { error: 'assemblyItemId query param is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const bom = await getBom(ctx, assemblyItemId);
    return NextResponse.json({ assemblyItemId, components: bom });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/assemblies]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PUT /api/assemblies ───────────────────────────────────────────────────────

export async function PUT(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req) as {
      assemblyItemId?: string;
      components?: Array<{ componentItemId: string; quantity: string | number }>;
    };

    const { assemblyItemId, components } = body;

    if (!assemblyItemId) {
      return NextResponse.json(
        { error: 'assemblyItemId is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const bom = await setBom(ctx, assemblyItemId, components ?? []);
    return NextResponse.json({ assemblyItemId, components: bom });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[PUT /api/assemblies]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PATCH /api/assemblies — alias for PUT (client.ts uses api.patch) ──────────

export { PUT as PATCH };
