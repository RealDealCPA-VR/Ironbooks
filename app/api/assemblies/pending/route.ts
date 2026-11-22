/**
 * GET  /api/assemblies/pending?status=pending  — list pending builds (with live shortage detail)
 * POST /api/assemblies/pending                 — queue a pending build
 *
 * POST body: { assemblyItemId: string; quantity: string | number; date: string; memo?: string }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createPendingBuild, listPendingBuilds } from '@/lib/services/assemblies';
import { inventoryDate } from '@/lib/services/inventory';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';
import { bodyValidationError } from '@/lib/validation/helpers';
import { createPendingBuildSchema } from '@/lib/validation/assemblies';

function serviceErrorToResponse(err: ServiceError): NextResponse {
  const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
  return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const status = req.nextUrl.searchParams.get('status');
    const builds = await listPendingBuilds(ctx, status || null);
    return NextResponse.json({ builds });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[GET /api/assemblies/pending]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req)) as {
      assemblyItemId?: string;
      quantity?: string | number;
      date?: string;
      memo?: string | null;
    };

    if (!body.assemblyItemId) {
      return NextResponse.json(
        { error: 'assemblyItemId is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (body.quantity == null) {
      return NextResponse.json({ error: 'quantity is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!body.date) {
      return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
    }
    // The body as agents read it described (lib/validation/assemblies.ts). The checks above answer
    // first; it refuses only what the service could not use anyway.
    const checked = createPendingBuildSchema.safeParse(body);
    if (!checked.success) throw bodyValidationError(checked.error);

    const build = await createPendingBuild(ctx, {
      assemblyItemId: body.assemblyItemId,
      quantity: body.quantity,
      date: inventoryDate(body.date),
      memo: body.memo ?? null,
    });

    return NextResponse.json({ build }, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceError) return serviceErrorToResponse(err);
    console.error('[POST /api/assemblies/pending]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
