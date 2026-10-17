/**
 * GET   /api/tax-rates/[id]/components  — list components for a tax rate
 * PATCH /api/tax-rates/[id]/components  — replace all components (recomputes parent rate)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listComponents, setComponents } from '@/lib/services/combinedTax';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[tax-rates/components] error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await listComponents(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const components = body?.components;
    if (!Array.isArray(components)) {
      return NextResponse.json(
        { error: 'Request body must be { components: [...] }', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const rows = await setComponents(ctx, id, components);
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
