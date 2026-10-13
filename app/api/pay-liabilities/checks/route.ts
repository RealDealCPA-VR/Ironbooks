/** GET /api/pay-liabilities/checks — payroll Liability Checks (newest first). */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { listPaymentChecks } from '@/lib/services/liabilityPayments';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ items: await listPaymentChecks(ctx, { kind: 'payroll_liability' }) });
  } catch (err) {
    return routeError(err, 'GET /api/pay-liabilities/checks');
  }
}
