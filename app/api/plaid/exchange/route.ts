/**
 * POST /api/plaid/exchange
 * Body: { publicToken: string }
 * Exchanges a Plaid Link public token for a permanent access token.
 * Returns { accessToken: string } — the caller should store this securely.
 *
 * NOTE: In production you would encrypt and persist the access token server-side
 * (e.g. in an encrypted column on bank_accounts). For this implementation, the
 * token is returned to the client, which passes it back on subsequent sync calls.
 * Never log or expose the access token in the response beyond what is necessary.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { exchangePublicToken } from '@/lib/services/plaid';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[plaid/exchange] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    // Auth first (session + Banking permission via the central route map), then the network
    // policy is enforced inside the service.
    const ctx = await getServerContext();
    const body = await req.json();
    const { publicToken } = body as { publicToken?: string };
    if (!publicToken || typeof publicToken !== 'string') {
      return NextResponse.json({ error: 'publicToken is required', code: 'VALIDATION' }, { status: 400 });
    }
    const accessToken = await exchangePublicToken(ctx, publicToken);
    return NextResponse.json({ accessToken });
  } catch (err) {
    return errorResponse(err);
  }
}
