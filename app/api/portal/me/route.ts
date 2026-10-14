/** GET /api/portal/me — the signed-in employee's profile + their paychecks. */
import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { employees, paychecks } from '@/lib/db/schema';
import { getPortalEmployeeId } from '@/lib/auth';

export async function GET() {
  const employeeId = await getPortalEmployeeId();
  if (!employeeId) return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
  const db = await getDb();
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
  // getPortalEmployeeId already requires an active employee with a current portal password;
  // re-check here so this route never serves a deactivated employee's data.
  if (!emp || !emp.isActive || !emp.portalPasswordHash) {
    return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
  }
  const checks = await db
    .select()
    .from(paychecks)
    // Real paychecks only — historical YTD / liability adjustments are bookkeeping entries.
    .where(and(eq(paychecks.employeeId, employeeId), eq(paychecks.entryType, 'paycheck')))
    .orderBy(desc(paychecks.payDate));
  return NextResponse.json({
    employee: { id: emp.id, name: `${emp.firstName} ${emp.lastName}`, email: emp.email, payType: emp.payType },
    paychecks: checks,
  });
}
