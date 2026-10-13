/** POST /api/pay-liabilities/checks/[id] { action: 'void' } — void a payroll Liability Check. */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getPaymentCheck, voidPaymentCheck } from '@/lib/services/liabilityPayments';
import { notFound } from '@/lib/services/_base';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== 'void') {
      return NextResponse.json({ error: 'action must be "void".', code: 'VALIDATION' }, { status: 400 });
    }
    const check = await getPaymentCheck(ctx, id);
    if (check.kind !== 'payroll_liability') throw notFound('Liability check');
    return NextResponse.json(await voidPaymentCheck(ctx, id));
  } catch (err) {
    return routeError(err, 'POST /api/pay-liabilities/checks/[id]');
  }
}
