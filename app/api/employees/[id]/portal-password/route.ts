/**
 * POST /api/employees/[id]/portal-password — owner/admin sets an employee's self-service password.
 * Body: { password }. Requires a main app session (Employees & Payroll: modify). The company file's
 * password rules apply (lib/passwordPolicy.ts — the same rules as every other login), and the change
 * is audited (never the password). Setting a new password ends the employee's existing portal
 * sessions (portal tokens are bound to the password; see lib/auth.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getServerContext } from '@/lib/context';
import { hashPassword } from '@/lib/auth';
import { employees } from '@/lib/db/schema';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { passwordProblemMessage, passwordProblems } from '@/lib/passwordPolicy';
import { getPasswordPolicy } from '@/lib/services/passwordPolicy';
import { writeAudit } from '@/lib/services/_base';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const { password } = body;
    if (typeof password !== 'string' || !password) {
      return NextResponse.json({ error: 'A password is required.', code: 'VALIDATION' }, { status: 400 });
    }
    // The file's password rules (review round 5: the portal password only had to be 8 characters).
    const problems = passwordProblems(password, await getPasswordPolicy(ctx.db));
    if (problems.length) {
      return NextResponse.json({ error: passwordProblemMessage(problems), code: 'VALIDATION' }, { status: 400 });
    }
    const [emp] = await ctx.db
      .select({ id: employees.id, hadPassword: employees.portalPasswordHash })
      .from(employees)
      .where(and(eq(employees.id, id), eq(employees.companyId, ctx.companyId)));
    if (!emp) return NextResponse.json({ error: 'Employee not found', code: 'NOT_FOUND' }, { status: 404 });
    await ctx.db
      .update(employees)
      .set({ portalPasswordHash: await hashPassword(password) })
      .where(and(eq(employees.id, id), eq(employees.companyId, ctx.companyId)));
    // Audited like every other password change (never the password or its hash).
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'employee',
      entityId: id,
      oldValues: { hasPortalPassword: Boolean(emp.hadPassword) },
      newValues: { portalPasswordSet: true },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return routeError(err, 'employees/portal-password');
  }
}
