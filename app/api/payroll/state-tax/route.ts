/**
 * POST /api/payroll/state-tax
 *
 * Stateless state income-tax withholding estimator — no DB write, no GL impact.
 * Accepts gross per period, pay frequency, and state; returns the per-period
 * state income-tax withholding.
 *
 * Request body:
 *   { grossPerPeriod: string|number, periodsPerYear: number, state: string }
 *
 * Response (200):
 *   { stateTax: string, annualStateTax: string, stateCode: string, stateName: string, rateLabel: string }
 *   (monetary values as 2-dp decimal strings)
 *
 * APPROXIMATION: rates are ~2024 public figures for estimation only.
 * Always verify with the official state revenue department before filing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { statePerPeriod, SUPPORTED_STATE_CODES } from '@/lib/services/statePayrollTax';
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

    const result = statePerPeriod({
      grossPerPeriod: gross,
      periodsPerYear: periods,
      state: stateCode,
    });

    return NextResponse.json({
      stateTax: result.stateTax,
      annualStateTax: result.annualStateTax,
      stateCode: result.stateInfo.code,
      stateName: result.stateInfo.name,
      rateLabel: result.stateInfo.rateLabel,
    });
  } catch (err) {
    console.error('[payroll/state-tax] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
