/**
 * POST /api/users/[id]/reset-password — { password, requireChange?, turnOffTwoFactor? } set a new
 * password for a user (and optionally turn off their two-factor sign-in, for a lost authenticator).
 * Users & Roles 'modify'; a non-Admin cannot reset the password of a user with more access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resetUserPassword } from '@/lib/services/users';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { resetPasswordSchema } from '@/lib/validation/users';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[users/[id]/reset-password]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    await resetUserPassword(ctx, id, parsed.data.password, {
      requireChange: parsed.data.requireChange,
      turnOffTwoFactor: parsed.data.turnOffTwoFactor,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
