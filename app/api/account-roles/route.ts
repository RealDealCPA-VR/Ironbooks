/**
 * Company > System Accounts — the accounts Ironbooks posts to on its own, by role
 * (lib/services/accountRoles.ts).
 * GET   /api/account-roles → AccountRoleRow[] (which account each role uses now, why, and the
 *       accounts it could use)
 * PATCH /api/account-roles { role, accountId | null } → the updated row (null = back to the
 *       automatic choice). Needs Company & Preferences: modify (checked by the service too).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { ACCOUNT_ROLE_KEYS, listAccountRoles, setAccountRole, type AccountRole } from '@/lib/services/accountRoles';

const patchSchema = z.object({
  role: z.enum(ACCOUNT_ROLE_KEYS as [AccountRole, ...AccountRole[]]),
  accountId: z.string().uuid().nullable(),
});

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
    const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await setAccountRole(ctx, parsed.data.role, parsed.data.accountId));
  } catch (err) {
    return routeError(err, '/api/account-roles');
  }
}
