/**
 * POST /api/plaid/link-token
 * Creates a Plaid Link token for the current company.
 * Returns { linkToken: string } or an error payload.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createLinkToken } from '@/lib/services/plaid';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[plaid/link-token] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST() {
  try {
    const ctx = await getServerContext();
    const linkToken = await createLinkToken(ctx);
    return NextResponse.json({ linkToken });
  } catch (err) {
    return errorResponse(err);
  }
}
