/** POST /api/pay-liabilities/checks/[id] { action: 'void' } — void a payroll Liability Check. */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { getPaymentCheck, voidPaymentCheck } from '@/lib/services/liabilityPayments';
import { notFound } from '@/lib/services/_base';
import { bodyValidationError } from '@/lib/validation/helpers';
import { voidLiabilityCheckSchema } from '@/lib/validation/liabilities';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const body = (await requireJsonObject(req, { optional: true })) as { action?: string };
    if (body.action !== 'void') {
      return NextResponse.json({ error: 'action must be "void".', code: 'VALIDATION' }, { status: 400 });
    }
    // The body as agents read it described (lib/validation/liabilities.ts); the check above answers first.
    const checked = voidLiabilityCheckSchema.safeParse(body);
    if (!checked.success) throw bodyValidationError(checked.error);
    const check = await getPaymentCheck(ctx, id);
    if (check.kind !== 'payroll_liability') throw notFound('Liability check');
    return NextResponse.json(await voidPaymentCheck(ctx, id));
  } catch (err) {
    return routeError(err, 'POST /api/pay-liabilities/checks/[id]');
  }
}
