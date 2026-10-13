/**
 * Pay Sales Tax (QB Vendors > Sales Tax > Pay Sales Tax) — sales_tax area, not payroll.
 *
 * GET  ?dueThrough=YYYY-MM-DD
 *   → { basis, frequency, defaultDueThrough, dueThrough, rows: [{ agencyId, agencyName, payee,
 *       owedThrough, settledLater, amountDue, ... }], totalDue }
 *   basis = the company's "owe sales tax" preference (accrual / cash); dueThrough defaults to the
 *   end of the last filing period for the company's filing frequency.
 *
 * POST { date, paymentAccountId, payments: [{ agencyId, amount }], memo?, checkNumber?,
 *        toPrint?, dueThrough?, allowDuplicateNumber? }
 *   → 201 { checks: [...], total } — one Sales Tax Payment check per agency.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { paySalesTaxAgencies, paySalesTaxScreen } from '@/lib/services/liabilityPayments';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const dueThrough = req.nextUrl.searchParams.get('dueThrough');
    if (dueThrough && !DAY_RE.test(dueThrough)) {
      return NextResponse.json({ error: 'dueThrough must be a date (YYYY-MM-DD).', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(await paySalesTaxScreen(ctx, { dueThrough }));
  } catch (err) {
    return routeError(err, 'GET /api/sales-tax/pay');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const bad = (error: string) => NextResponse.json({ error, code: 'VALIDATION' }, { status: 400 });
    if (typeof body.date !== 'string' || Number.isNaN(new Date(body.date).getTime())) return bad('Enter the check date.');
    if (typeof body.paymentAccountId !== 'string' || !body.paymentAccountId) return bad('Pick the bank account to pay from.');
    if (!Array.isArray(body.payments) || body.payments.length === 0) return bad('Pick at least one tax agency to pay.');
    const payments = (body.payments as Array<Record<string, unknown>>).map((p) => ({
      agencyId: typeof p?.agencyId === 'string' ? p.agencyId : '',
      amount: typeof p?.amount === 'string' || typeof p?.amount === 'number' ? (p.amount as string | number) : '',
    }));
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const res = await paySalesTaxAgencies(ctx, {
      date: new Date(body.date),
      paymentAccountId: body.paymentAccountId,
      payments,
      memo: str(body.memo),
      checkNumber: str(body.checkNumber),
      toPrint: body.toPrint === true,
      dueThrough: str(body.dueThrough),
      allowDuplicateNumber: body.allowDuplicateNumber === true,
    });
    return NextResponse.json(res, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/sales-tax/pay');
  }
}
