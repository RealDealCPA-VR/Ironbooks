/**
 * Reclassify Transactions.
 * GET  /api/accountant/reclassify?accountId=&from=&to=&sourceType= → lines on the account
 * POST /api/accountant/reclassify { lineIds, newAccountId?, newClassId? } → change in place
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { listReclassifyLines, reclassifyLines } from '@/lib/services/accountant/reclassify';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { reclassifySchema } from '@/lib/validation/accountant';
import { dayParam } from '../_lib';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const accountId = sp.get('accountId') ?? '';
    if (!UUID.test(accountId)) throw new ServiceError('VALIDATION', 'Choose an account.');
    return NextResponse.json(
      await listReclassifyLines(ctx, {
        accountId,
        from: dayParam(sp.get('from'), 'from'),
        to: dayParam(sp.get('to'), 'to', true),
        sourceType: sp.get('sourceType'),
      }),
    );
  } catch (err) {
    return routeError(err, '/api/accountant/reclassify');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = reclassifySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await reclassifyLines(ctx, parsed.data));
  } catch (err) {
    return routeError(err, '/api/accountant/reclassify');
  }
}
