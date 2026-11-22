/**
 * POST /api/demo-feed — load sample bank transactions into staging for a bank account.
 * Lets the banking workflow be exercised without any external feed provider.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { loadDemoFeed } from '@/lib/services/demoFeed';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';
import { bodyValidationError } from '@/lib/validation/helpers';
import { loadDemoFeedSchema } from '@/lib/validation/bankTransactions';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { bankAccountId } = body;
    if (!bankAccountId) {
      return NextResponse.json({ error: 'bankAccountId is required', code: 'VALIDATION' }, { status: 400 });
    }
    // The body as agents read it described (lib/validation/bankTransactions.ts); the check above answers first.
    const checked = loadDemoFeedSchema.safeParse(body);
    if (!checked.success) throw bodyValidationError(checked.error);
    return NextResponse.json(await loadDemoFeed(ctx, bankAccountId));
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
