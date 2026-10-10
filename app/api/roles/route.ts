/**
 * GET  /api/roles — built-in + custom roles (with user counts) and the permission catalog
 *                   (areas, actions, flags) for the role editor's matrix.
 * POST /api/roles — create a custom role { name, description?, permissions, flags } or clone
 *                   one { cloneFrom: roleKey, name, description? }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createRole, listRoles } from '@/lib/services/users';
import {
  ACTIONS,
  AREAS,
  AREA_DESCRIPTIONS,
  FLAGS,
  type PermissionGrant,
  type RoleFlags,
} from '@/lib/permissions/model';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createRoleSchema } from '@/lib/validation/users';

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
  console.error('[roles/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({
      roles: await listRoles(ctx),
      catalog: {
        areas: AREAS.map((a) => ({ ...a, description: AREA_DESCRIPTIONS[a.key] })),
        actions: ACTIONS,
        flags: FLAGS,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createRoleSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const d = parsed.data;
    const role = await createRole(
      ctx,
      'cloneFrom' in d
        ? d
        : {
            name: d.name,
            description: d.description,
            permissions: d.permissions as PermissionGrant,
            flags: d.flags as RoleFlags,
          },
    );
    return NextResponse.json(role, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
