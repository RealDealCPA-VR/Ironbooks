/**
 * GET  /api/users — users of the active company with their roles (Users & Roles).
 * POST /api/users — add a user: { name, login, password, roleKeys[] }.
 *
 * Permission (central route map): Users & Roles view / create. Escalation and last-Admin rules
 * are enforced in lib/services/users.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { addUser, listUsers } from '@/lib/services/users';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createUserSchema } from '@/lib/validation/users';

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
  console.error('[users/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listUsers(ctx));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await addUser(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
