/**
 * POST /api/payroll/calc
 *
 * Stateless federal withholding calculator — no DB write, no GL impact.
 * Accepts gross per period, pay frequency, and filing status; returns
 * the per-period withholding breakdown.
 *
 * Request body:
 *   { grossPerPeriod: string|number, periodsPerYear: number, filingStatus: 'single'|'married' }
 *
 * Response (200):
 *   { federalIncomeTax, socialSecurity, medicare, totalPerPeriod, net }
 *   (all as 2-dp decimal strings)
 */
import { NextRequest, NextResponse } from 'next/server';
import { computeWithholding, type FilingStatus } from '@/lib/services/payrollTax';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';

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
          { status: err.code === 'FORBIDDEN' ? 403 : 400 },
        );
      }
      throw err;
    }
    const body = await req.json();

    const { grossPerPeriod, periodsPerYear, filingStatus } = body as {
      grossPerPeriod?: unknown;
      periodsPerYear?: unknown;
      filingStatus?: unknown;
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
    if (filingStatus !== 'single' && filingStatus !== 'married') {
      return errorResponse("filingStatus must be 'single' or 'married'");
    }

    const result = computeWithholding({
      grossPerPeriod: gross,
      periodsPerYear: periods,
      filingStatus: filingStatus as FilingStatus,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[payroll/calc] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
