/**
 * GET  /api/bank-accounts  — list bank/credit-card accounts
 * POST /api/bank-accounts  — create one (links a GL asset/liability account)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listBankAccounts, createBankAccount } from '@/lib/services/bankAccounts';
import { ServiceError } from '@/lib/services/_base';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' || err.code === 'UNBALANCED' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
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
    const body = await req.json();
    return NextResponse.json(await createBankAccount(ctx, body), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
