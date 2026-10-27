/**
 * POST /api/employees/[id]/portal-password — owner/admin sets an employee's self-service password.
 * Body: { password }. Requires a main app session. Setting a new password ends the employee's
 * existing portal sessions (portal tokens are bound to the password; see lib/auth.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { getServerContext } from '@/lib/context';
import { inTransaction, writeAudit } from '@/lib/services/_base';
import { getSessionUserId, hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth';
import { employees } from '@/lib/db/schema';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    if (!userId) return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const { password } = body;
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const ctx = await getServerContext();
    const [emp] = await ctx.db
      .select({ id: employees.id, hadPassword: sql<boolean>`${employees.portalPasswordHash} IS NOT NULL` })
      .from(employees)
      .where(and(eq(employees.id, id), eq(employees.companyId, ctx.companyId)));
    if (!emp) return NextResponse.json({ error: 'Employee not found', code: 'NOT_FOUND' }, { status: 404 });
    const portalPasswordHash = await hashPassword(password);
    // One transaction with an audit row (who gave this employee portal access, and when) — never
    // the hash itself. inTransaction / writeAudit also apply the view-only role check.
    await inTransaction(ctx, async (tx) => {
      await tx.db
        .update(employees)
        .set({ portalPasswordHash, updatedAt: new Date() })
        .where(and(eq(employees.id, id), eq(employees.companyId, tx.companyId)));
      await writeAudit(tx, {
        action: 'update',
        entityType: 'employee',
        entityId: id,
        oldValues: { portalPassword: emp.hadPassword ? 'set' : 'none' },
        newValues: { portalPassword: 'set' },
      });
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return routeError(err, 'employees/portal-password');
  }
}
