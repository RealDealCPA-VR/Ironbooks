/**
 * POST /api/sales-forms/statement-email — email a customer statement PDF (wave2 sales C7).
 * Body: { customerId, from?, to?, email? }  (from/to = statement period, ISO dates).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { emailCustomerStatement } from '@/lib/services/salesForms';
import { routeError } from '@/lib/routeErrors';

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    // A JSON null reads as {} → 400 below (never a TypeError).
    const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (typeof body.customerId !== 'string' || !body.customerId) {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(
      await emailCustomerStatement(ctx, body.customerId, {
        from: parseDate(body.from),
        to: parseDate(body.to),
        email: typeof body.email === 'string' ? body.email : null,
      }),
    );
  } catch (err) {
    return routeError(err, 'POST /api/sales-forms/statement-email');
  }
}
