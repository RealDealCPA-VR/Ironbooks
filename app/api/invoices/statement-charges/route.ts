/**
 * GET  /api/invoices/statement-charges?customerId= — a customer register of statement charges.
 * POST /api/invoices/statement-charges            — enter a statement charge (wave2 sales C5).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createStatementCharge, listStatementCharges } from '@/lib/services/batchInvoicing';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { statementChargeSchema } from '@/lib/validation/sales';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId') ?? undefined;
    return NextResponse.json({ charges: await listStatementCharges(ctx, { customerId }) });
  } catch (err) {
    return routeErrorWithWarnings(err, 'GET /api/invoices/statement-charges');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = statementChargeSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createStatementCharge(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeErrorWithWarnings(err, 'POST /api/invoices/statement-charges');
  }
}
