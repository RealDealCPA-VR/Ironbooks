/**
 * GET  /api/sales-tax/payments/[id]                   — one Sales Tax Payment check
 * POST /api/sales-tax/payments/[id] { action: 'void' } — void it (the tax is owed again)
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getPaymentCheck, voidPaymentCheck } from '@/lib/services/liabilityPayments';
import { type ServiceContext, notFound } from '@/lib/services/_base';

type Params = { params: Promise<{ id: string }> };

async function salesTaxCheck(ctx: ServiceContext, id: string) {
  const check = await getPaymentCheck(ctx, id);
  if (check.kind !== 'sales_tax') throw notFound('Sales tax payment');
  return check;
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    return NextResponse.json(await salesTaxCheck(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/sales-tax/payments/[id]');
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== 'void') {
      return NextResponse.json({ error: 'action must be "void".', code: 'VALIDATION' }, { status: 400 });
    }
    await salesTaxCheck(ctx, id);
    return NextResponse.json(await voidPaymentCheck(ctx, id));
  } catch (err) {
    return routeError(err, 'POST /api/sales-tax/payments/[id]');
  }
}
