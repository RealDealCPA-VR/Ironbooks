/** GET /api/portal/me — the signed-in employee's profile + their paychecks. */
import { NextResponse } from 'next/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { employees, journalEntries, paychecks } from '@/lib/db/schema';
import { getPortalEmployeeId } from '@/lib/auth';

export async function GET() {
  const employeeId = await getPortalEmployeeId();
  if (!employeeId) return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
  const db = await getDb();
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
  // getPortalEmployeeId already requires an active employee (of a non-archived company) with a current portal password;
  // re-check here so this route never serves a deactivated employee's data.
  if (!emp || !emp.isActive || !emp.portalPasswordHash) {
    return NextResponse.json({ error: 'Not authenticated', code: 'FORBIDDEN' }, { status: 401 });
  }
  const rows = await db
    .select({ paycheck: paychecks })
    .from(paychecks)
    .innerJoin(journalEntries, eq(journalEntries.id, paychecks.postedEntryId))
    // Real, live paychecks only — historical YTD / liability adjustments are bookkeeping entries,
    // and a voided check (voided_at, or its journal entry no longer posted) was never paid.
    .where(
      and(
        eq(paychecks.employeeId, employeeId),
        eq(paychecks.companyId, emp.companyId),
        eq(paychecks.entryType, 'paycheck'),
        isNull(paychecks.voidedAt),
        eq(journalEntries.status, 'posted'),
      ),
    )
    .orderBy(desc(paychecks.payDate));
  return NextResponse.json({
    employee: { id: emp.id, name: `${emp.firstName} ${emp.lastName}`, email: emp.email, payType: emp.payType },
    paychecks: rows.map((r) => r.paycheck),
  });
}
