/**
 * GET /api/users/password-policy — the company file's password policy (Users & Roles: view).
 * PUT /api/users/password-policy — save it: { minLength?, requireLettersAndNumbers?,
 *     requireSymbol?, expiryDays?, historyCount? }. The policy covers every login in the file, so
 *     only an Admin of every company in the file may change it (lib/services/passwordPolicy.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getPasswordPolicy, updatePasswordPolicy } from '@/lib/services/passwordPolicy';
import { describePasswordPolicy } from '@/lib/passwordPolicy';
import { passwordPolicySchema } from '@/lib/validation/users';
import { zodErrorBody } from '@/lib/validation/helpers';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    const policy = await getPasswordPolicy(ctx.db);
    return NextResponse.json({ ...policy, description: describePasswordPolicy(policy) });
  } catch (err) {
    return routeError(err, 'GET /api/users/password-policy');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = passwordPolicySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const policy = await updatePasswordPolicy(ctx, parsed.data);
    return NextResponse.json({ ...policy, description: describePasswordPolicy(policy) });
  } catch (err) {
    return routeError(err, 'PUT /api/users/password-policy');
  }
}
