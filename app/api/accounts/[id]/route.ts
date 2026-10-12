/**
 * GET    /api/accounts/[id]  — fetch one account
 * PATCH  /api/accounts/[id]  — update mutable fields
 * DELETE /api/accounts/[id]  — soft-deactivate
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import { getAccount, updateAccount, deactivateAccount } from '@/lib/services/accounts';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateAccountSchema } from '@/lib/validation/accounts';

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
  console.error('[accounts/[id]] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getAccount(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = updateAccountSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    return NextResponse.json(await withVersionCheck(ctx, 'account', id, expectedVersion(req), (c) => updateAccount(c, id, parsed.data)));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await withVersionCheck(ctx, 'account', id, expectedVersion(req), (c) => deactivateAccount(c, id)));
  } catch (err) {
    return errorResponse(err);
  }
}
