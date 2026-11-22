/**
 * Company > System Accounts — the accounts Ironbooks posts to on its own, by role
 * (lib/services/accountRoles.ts).
 * GET   /api/account-roles → AccountRoleRow[] (which account each role uses now, why, and the
 *       accounts it could use)
 * PATCH /api/account-roles { role, accountId | null } → the updated row (null = back to the
 *       automatic choice). Needs Company & Preferences: modify (checked by the service too).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { setAccountRoleSchema } from '@/lib/validation/accountRoles';
import { listAccountRoles, setAccountRole } from '@/lib/services/accountRoles';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await listAccountRoles(ctx));
  } catch (err) {
    return routeError(err, '/api/account-roles');
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = setAccountRoleSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await setAccountRole(ctx, parsed.data.role, parsed.data.accountId));
  } catch (err) {
    return routeError(err, '/api/account-roles');
  }
}
