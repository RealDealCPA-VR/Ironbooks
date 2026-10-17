/**
 * GET   /api/users/[id] — one user with their effective (union) permissions.
 * PATCH /api/users/[id] — { name?, login?, roleKeys?, isActive? } edit / change roles /
 *                         deactivate (isActive:false) / reactivate (true).
 *                         Legacy body { role: 'owner'|'admin'|'accountant'|'viewer' } is still
 *                         accepted and mapped to the equivalent built-in role.
 *
 * The last active Admin can never be deactivated or lose the Admin role (lib/services/users.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { setMemberRole, type Role } from '@/lib/services/rbac';
import { getUser, updateUser } from '@/lib/services/users';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateUserSchema } from '@/lib/validation/users';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[users/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getUser(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    if (typeof body?.role === 'string') {
      await setMemberRole(ctx, id, body.role as Role);
      return NextResponse.json(await getUser(ctx, id));
    }
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateUser(ctx, id, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}
