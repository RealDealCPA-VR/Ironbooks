/**
 * GET /api/payroll/paystub?paycheckId=<uuid>
 *
 * Loads the paycheck, its lines, the employee, and the company, then renders
 * a pay stub PDF and returns it inline (application/pdf).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getPortalEmployeeId, getSessionUserId } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { ServiceError } from '@/lib/services/_base';
import { renderPaystubPdf } from '@/lib/pdf/paystub';
import { payStubData } from '@/lib/services/payroll';
import { and, eq } from 'drizzle-orm';
import { paychecks, employees, companies } from '@/lib/db/schema';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[payroll/paystub] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** A file name for Content-Disposition: accents dropped, anything else outside [A-Za-z0-9._-] → _. */
function headerSafeFilename(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** Format a Date or timestamp to YYYY-MM-DD. */
function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;

    const paycheckId = searchParams.get('paycheckId');
    if (!paycheckId) {
      return NextResponse.json(
        { error: 'paycheckId query parameter is required.' },
        { status: 400 },
      );
    }

    const db = await getDb();

    // Two authorized callers:
    //  - A main-app user / employer (bka_session): may fetch any stub in their company.
    //  - An employee in the self-service portal (bka_portal): may fetch ONLY their own stubs.
    // The main session is checked FIRST so a stale portal cookie in the same browser can never
    // shadow the employer's access; the portal cookie is only consulted when the main session
    // does not authorize the request. getPortalEmployeeId() also requires the employee to be
    // active with a current portal password. Anyone else gets getServerContext()'s FORBIDDEN.
    let companyId: string;
    let paycheck:
      | typeof paychecks.$inferSelect
      | undefined;

    let ctx: Awaited<ReturnType<typeof getServerContext>> | null = null;
    let mainErr: unknown = null;
    if (await getSessionUserId()) {
      try {
        ctx = await getServerContext();
      } catch (err) {
        mainErr = err; // e.g. no payroll permission — the portal cookie may still authorize
      }
    }
    const portalEmployeeId = ctx ? null : await getPortalEmployeeId();
    if (!ctx && !portalEmployeeId) {
      if (mainErr) throw mainErr;
      ctx = await getServerContext(); // no session at all: throws FORBIDDEN (or first-run fallback)
    }

    if (ctx) {
      companyId = ctx.companyId;
      [paycheck] = await db
        .select()
        .from(paychecks)
        .where(and(eq(paychecks.id, paycheckId), eq(paychecks.companyId, companyId)));
    } else {
      if (!portalEmployeeId) throw mainErr; // unreachable: handled above
      const [emp] = await db
        .select()
        .from(employees)
        .where(eq(employees.id, portalEmployeeId));
      if (!emp) {
        return NextResponse.json({ error: 'Employee not found.', code: 'NOT_FOUND' }, { status: 404 });
      }
      companyId = emp.companyId;
      // Scope by employeeId so one employee can never read another's pay stub.
      [paycheck] = await db
        .select()
        .from(paychecks)
        .where(and(eq(paychecks.id, paycheckId), eq(paychecks.employeeId, portalEmployeeId)));
    }

    if (!paycheck) {
      return NextResponse.json({ error: 'Paycheck not found.', code: 'NOT_FOUND' }, { status: 404 });
    }

    // Load company.
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!company) {
      return NextResponse.json({ error: 'Company not found.', code: 'NOT_FOUND' }, { status: 404 });
    }

    // Load the stub with calendar-YTD aggregates (posted, non-void checks of the
    // same year through this stub's pay date). Read-only context; authorization
    // was already enforced above for both portal and main-app sessions.
    const stub = await payStubData({ db, companyId, userId: null }, paycheckId);
    const { employee } = stub;

    // Render PDF (with YTD column).
    const pdfBytes = await renderPaystubPdf({
      company: { name: company.name },
      employee: {
        firstName: employee.firstName,
        lastName:  employee.lastName,
      },
      paycheck: {
        payDate:     fmtDate(paycheck.payDate),
        periodStart: paycheck.periodStart ? fmtDate(paycheck.periodStart) : null,
        periodEnd:   paycheck.periodEnd   ? fmtDate(paycheck.periodEnd)   : null,
        grossPay:    paycheck.grossPay,
        netPay:      paycheck.netPay,
        ytdGross:    stub.ytd.gross,
        ytdNet:      stub.ytd.net,
      },
      lines: stub.lines.map((l) => ({
        kind:      l.kind as 'earning' | 'tax' | 'deduction' | 'employer_contribution',
        name:      l.name,
        amount:    l.amount,
        ytdAmount: l.ytdAmount,
      })),
      // Sick/vacation balances — rendered only when the employee has an accrual policy.
      accruals: stub.accruals,
      taxableWages: stub.taxableWages,
      isVoid: stub.isVoid,
    });

    // Slice to an owned ArrayBuffer (same pattern as the invoice PDF route).
    const arrayBuf: ArrayBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength,
    ) as ArrayBuffer;

    const empSlug = `${employee.lastName}-${employee.firstName}`.replace(/\s+/g, '-').toLowerCase();
    // Header-safe file name: a name like "Nguyễn" or one with quotes is not a valid header value
    // (the response threw → HTTP 500).
    const filename = headerSafeFilename(`paystub-${empSlug}-${fmtDate(paycheck.payDate)}.pdf`);

    return new NextResponse(arrayBuf, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length':      String(arrayBuf.byteLength),
        // Pay data: never cached by the browser.
        'Cache-Control':       'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
