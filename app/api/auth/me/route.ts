/**
 * GET /api/auth/me — the current authenticated user (or null), plus their EFFECTIVE permissions
 * in the active company: { ...user, companyId, roleKeys, permissions, flags, isAdmin }.
 *
 * The UI uses `permissions` to hide navigation it can't use (cosmetic — every API route is
 * enforced server-side by getServerContext + lib/permissions/routes.ts). When the context can't
 * be resolved (file locked, deactivated, first-run) the permission fields are null.
 */
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getServerContext } from '@/lib/context';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json(null);
  let access = null;
  let companyId: string | null = null;
  try {
    const ctx = await getServerContext();
    if (ctx.userId === user.id && ctx.access) {
      access = ctx.access;
      companyId = ctx.companyId;
    }
  } catch {
    /* locked / deactivated — report the user without permissions */
  }
  return NextResponse.json({
    ...user,
    companyId,
    roleKeys: access?.roleKeys ?? null,
    permissions: access?.permissions ?? null,
    flags: access?.flags ?? null,
    isAdmin: access?.isAdmin ?? false,
  });
}
