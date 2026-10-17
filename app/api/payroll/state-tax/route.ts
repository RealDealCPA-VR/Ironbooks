/**
 * POST /api/payroll/state-tax
 *
 * Stateless state income-tax withholding estimator — no DB write, no GL impact.
 * Accepts gross per period, pay frequency, and state; returns the per-period
 * state income-tax withholding.
 *
 * Request body:
 *   { grossPerPeriod: string|number, periodsPerYear: number, state: string,
 *     year?: number, filingStatus?: 'single'|'married'|'married_separate'|'head_of_household' }
 *
 * Response (200):
 *   { stateTax, annualStateTax, stateCode, stateName, rateLabel, method, notes }
 *   (monetary values as 2-dp decimal strings)
 *
 * Same year-keyed engine as paychecks (lib/services/statePayrollTax.ts); states the app does not
 * calculate return 0 with a note (never a guess).
 */
import { NextRequest, NextResponse } from 'next/server';
import { statePerPeriod, SUPPORTED_STATE_CODES } from '@/lib/services/statePayrollTax';
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

    const { grossPerPeriod, periodsPerYear, state } = body as {
      grossPerPeriod?: unknown;
      periodsPerYear?: unknown;
      state?: unknown;
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

    // Validate state
    if (!state || typeof state !== 'string' || state.trim() === '') {
      return errorResponse('state is required (two-letter code, e.g. "CA")');
    }
    const stateCode = state.trim().toUpperCase();
    if (!SUPPORTED_STATE_CODES.includes(stateCode)) {
      return errorResponse(
        `state '${stateCode}' is not supported. Supported states: ${SUPPORTED_STATE_CODES.join(', ')}`,
      );
    }

    const { year, filingStatus } = body as { year?: unknown; filingStatus?: unknown };
    const taxYear = year === undefined || year === null || year === '' ? undefined : Number(year);
    if (taxYear !== undefined && (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100)) {
      return errorResponse('year must be a four-digit year');
    }
    const fs = typeof filingStatus === 'string' ? filingStatus : undefined;
    if (fs && !['single', 'married', 'married_separate', 'head_of_household'].includes(fs)) {
      return errorResponse('filingStatus must be single, married, married_separate or head_of_household');
    }

    const result = statePerPeriod({
      grossPerPeriod: gross,
      periodsPerYear: periods,
      state: stateCode,
      year: taxYear,
      stateW4: fs ? { filingStatus: fs as 'single' } : null,
    });

    return NextResponse.json({
      stateTax: result.stateTax,
      annualStateTax: result.annualStateTax,
      stateCode: result.stateInfo.code,
      stateName: result.stateInfo.name,
      rateLabel: result.stateInfo.rateLabel,
      method: result.method,
      notes: result.notes,
    });
  } catch (err) {
    // e.g. requireJsonObject's VALIDATION for a malformed / non-object body.
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: serviceErrorStatus(err.code) });
    }
    console.error('[payroll/state-tax] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
