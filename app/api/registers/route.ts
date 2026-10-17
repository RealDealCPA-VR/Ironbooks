/**
 * GET /api/registers
 *
 * Lists the accounts that get a QB-style register — every active posting account (banks,
 * cards, A/R, A/P, assets, liabilities, equity, income, expense) — with their current cached
 * balances, for the registers index page.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { listRegisterAccounts } from '@/lib/services/journal';
import { serviceErrorStatus } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    const accounts = await listRegisterAccounts(ctx);
    return NextResponse.json({ accounts });
  } catch (err) {
    return mapError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared error mapper (code → HTTP status).
// ---------------------------------------------------------------------------
function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[registers] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
