/**
 * GET  /api/bank-accounts  — list bank/credit-card accounts
 * POST /api/bank-accounts  — create one (links a GL asset/liability account)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listBankAccounts, createBankAccount } from '@/lib/services/bankAccounts';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[bank-accounts] error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    // Account numbers are masked by the service for roles without the 'view full bank/account
    // numbers' flag (lib/services/bankAccounts.ts).
    return NextResponse.json(await listBankAccounts(ctx));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    return NextResponse.json(await createBankAccount(ctx, body as Parameters<typeof createBankAccount>[1]), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
