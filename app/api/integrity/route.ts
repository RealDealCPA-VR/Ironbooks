/**
 * GET /api/integrity
 *
 * Runs all data-integrity checks for the current company and returns a
 * structured report with per-check pass/fail status.
 *
 * Response shape:
 *   { checks: [{name, ok, detail}], allOk: boolean }
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { verifyIntegrity } from '@/lib/services/integrity';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    const result = await verifyIntegrity(ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[integrity] Unexpected error', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
