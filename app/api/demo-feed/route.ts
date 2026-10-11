/**
 * POST /api/demo-feed — load sample bank transactions into staging for a bank account.
 * Lets the banking workflow be exercised without any external feed provider.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { loadDemoFeed } from '@/lib/services/demoFeed';
import { ServiceError } from '@/lib/services/_base';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { bankAccountId } = await req.json();
    if (!bankAccountId) {
      return NextResponse.json({ error: 'bankAccountId is required', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(await loadDemoFeed(ctx, bankAccountId));
  } catch (err) {
    if (err instanceof ServiceError) {
      const status =
        err.code === 'NOT_FOUND' ? 404
        : err.code === 'VALIDATION' ? 400
        : err.code === 'FORBIDDEN' ? 403
        : 500;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
