/**
 * GET    /api/vendors/:id   — fetch a single vendor
 * PATCH  /api/vendors/:id   — update vendor fields
 * DELETE /api/vendors/:id   — deactivate (soft-delete) a vendor
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getVendor, updateVendor, deactivateVendor } from '@/lib/services/vendors';
import { ServiceError } from '@/lib/services/_base';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateVendorSchema } from '@/lib/validation/vendors';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[vendors/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const vendor = await getVendor(ctx, id);
    return NextResponse.json(vendor);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));

    // zod partial(): absent keys stay absent in the output, so the service can
    // distinguish "not supplied" from "explicitly set to null".
    const parsed = updateVendorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    // Multi-user: 409 if someone else saved this vendor since it was loaded.
    const vendor = await withVersionCheck(ctx, 'vendor', id, expectedVersion(req), (c) =>
      updateVendor(c, id, parsed.data),
    );
    return NextResponse.json(vendor);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const vendor = await withVersionCheck(ctx, 'vendor', id, expectedVersion(req), (c) =>
      deactivateVendor(c, id),
    );
    return NextResponse.json(vendor);
  } catch (err) {
    return errorResponse(err);
  }
}
