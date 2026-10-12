/**
 * GET    /api/roles/[id] — one role (built-in key or custom role id).
 * PATCH  /api/roles/[id] — edit a custom role { name?, description?, permissions?, flags? }.
 * DELETE /api/roles/[id] — delete a custom role (refused while assigned).
 * Built-in roles are read-only — clone them via POST /api/roles { cloneFrom }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteRole, getRoleDefinition, updateRole } from '@/lib/services/users';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateRoleSchema } from '@/lib/validation/users';
import type { PermissionGrant, RoleFlags } from '@/lib/permissions/model';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[roles/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getRoleDefinition(ctx, id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = updateRoleSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const d = parsed.data;
    return NextResponse.json(
      await updateRole(ctx, id, {
        name: d.name,
        description: d.description,
        permissions: d.permissions as PermissionGrant | undefined,
        flags: d.flags as RoleFlags | undefined,
      }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteRole(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
