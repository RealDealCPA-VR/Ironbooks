/**
 * GET    /api/customers/[id]  — fetch a single customer.
 * PATCH  /api/customers/[id]  — update mutable fields.
 * DELETE /api/customers/[id]  — soft-deactivate (isActive = false).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  getCustomer,
  updateCustomer,
  deactivateCustomer,
} from '@/lib/services/customers';
import { ServiceError } from '@/lib/services/_base';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateCustomerSchema } from '@/lib/validation/customers';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' || err.code === 'UNBALANCED' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[customers/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const customer = await getCustomer(ctx, id);
    return NextResponse.json(customer);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = updateCustomerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    // Multi-user: 409 if someone else saved this customer since it was loaded.
    const customer = await withVersionCheck(ctx, 'customer', id, expectedVersion(req), (c) =>
      updateCustomer(c, id, parsed.data),
    );
    return NextResponse.json(customer);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const customer = await withVersionCheck(ctx, 'customer', id, expectedVersion(req), (c) =>
      deactivateCustomer(c, id),
    );
    return NextResponse.json(customer);
  } catch (err) {
    return errorResponse(err);
  }
}
