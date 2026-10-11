/**
 * Write Off Invoices.
 * GET  /api/accountant/write-off?minDaysPastDue=&maxBalance=&customerId=&asOf= → candidates
 * POST /api/accountant/write-off { invoiceIds, date, badDebtAccountId, memo? }
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { listWriteOffCandidates, writeOffInvoices } from '@/lib/services/accountant/writeOff';
import { zodErrorBody } from '@/lib/validation/helpers';
import { writeOffSchema } from '@/lib/validation/accountant';
import { dayParam } from '../_lib';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const days = Number(sp.get('minDaysPastDue') ?? 0);
    const maxBalance = sp.get('maxBalance');
    const customerId = sp.get('customerId');
    return NextResponse.json({
      invoices: await listWriteOffCandidates(ctx, {
        asOf: dayParam(sp.get('asOf'), 'asOf', true),
        minDaysPastDue: Number.isFinite(days) && days > 0 ? Math.floor(days) : 0,
        maxBalance: maxBalance && /^\d+(\.\d{1,2})?$/.test(maxBalance) ? maxBalance : null,
        customerId: customerId && UUID.test(customerId) ? customerId : null,
      }),
    });
  } catch (err) {
    return routeError(err, '/api/accountant/write-off');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = writeOffSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await writeOffInvoices(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, '/api/accountant/write-off');
  }
}
