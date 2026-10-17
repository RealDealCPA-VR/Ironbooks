/**
 * GET  /api/accounts            — list chart of accounts (?includeInactive=true, ?tree=true)
 * POST /api/accounts            — create an account
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listAccounts, createAccount, getAccountTree } from '@/lib/services/accounts';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createAccountSchema } from '@/lib/validation/accounts';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[accounts] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = new URL(req.url);
    if (searchParams.get('tree') === 'true') {
      return NextResponse.json(await getAccountTree(ctx));
    }
    const includeInactive = searchParams.get('includeInactive') === 'true';
    return NextResponse.json(await listAccounts(ctx, { includeInactive }));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createAccountSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const account = await createAccount(ctx, parsed.data);
    return NextResponse.json(account, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
