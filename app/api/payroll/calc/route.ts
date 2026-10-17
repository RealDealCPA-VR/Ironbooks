/**
 * POST /api/payroll/calc
 *
 * Stateless federal withholding calculator — no DB write, no GL impact.
 * Accepts gross per period, pay frequency, and filing status; returns
 * the per-period withholding breakdown.
 *
 * Request body:
 *   { grossPerPeriod: string|number, periodsPerYear: number,
 *     filingStatus: 'single'|'married'|'head_of_household', year?: number, w4?: W4Data }
 *   year defaults to the current calendar year (the tables are keyed by year).
 *
 * Response (200):
 *   { federalIncomeTax, socialSecurity, medicare, totalPerPeriod, net }
 *   (all as 2-dp decimal strings)
 */
import { NextRequest, NextResponse } from 'next/server';
import { computeWithholding, type FilingStatus, type W4Data } from '@/lib/services/payrollTax';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  try {
    // Authorize (session + Employees & Payroll permission via the central route map).
    try {
      await getServerContext();
    } catch (err) {
      if (err instanceof ServiceError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: serviceErrorStatus(err.code) },
        );
      }
      throw err;
    }
    const body = await requireJsonObject(req);

    const { grossPerPeriod, periodsPerYear, filingStatus, year, w4 } = body as {
      grossPerPeriod?: unknown;
      periodsPerYear?: unknown;
      filingStatus?: unknown;
      year?: unknown;
      w4?: unknown;
    };

    // Validate grossPerPeriod
    if (grossPerPeriod === undefined || grossPerPeriod === null || grossPerPeriod === '') {
      return errorResponse('grossPerPeriod is required');
    }
    const gross = Number(grossPerPeriod);
    if (isNaN(gross) || gross <= 0) {
      return errorResponse('grossPerPeriod must be a positive number');
    }

    // Validate periodsPerYear
    if (periodsPerYear === undefined || periodsPerYear === null) {
      return errorResponse('periodsPerYear is required');
    }
    const periods = Number(periodsPerYear);
    if (!Number.isInteger(periods) || periods <= 0) {
      return errorResponse('periodsPerYear must be a positive integer');
    }

    // Validate filingStatus
    if (filingStatus !== 'single' && filingStatus !== 'married' && filingStatus !== 'head_of_household') {
      return errorResponse("filingStatus must be 'single', 'married' or 'head_of_household'");
    }
    const taxYear = year === undefined || year === null ? new Date().getUTCFullYear() : Number(year);
    if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
      return errorResponse('year must be a four-digit year');
    }

    const result = computeWithholding({
      grossPerPeriod: gross,
      periodsPerYear: periods,
      filingStatus: filingStatus as FilingStatus,
      year: taxYear,
      w4: w4 && typeof w4 === 'object' ? (w4 as W4Data) : null,
    });

    return NextResponse.json(result);
  } catch (err) {
    // e.g. requireJsonObject's VALIDATION for a malformed / non-object body.
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: serviceErrorStatus(err.code) });
    }
    console.error('[payroll/calc] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
