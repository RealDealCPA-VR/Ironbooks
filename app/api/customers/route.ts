/**
 * GET  /api/customers  — list customers for the active company.
 * POST /api/customers  — create a new customer.
 *
 * Query params for GET:
 *   ?includeInactive=true  — include deactivated customers.
 *   ?balanceSummary=true   — instead of the full list, return the balance summary.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  listCustomers,
  createCustomer,
  customerBalanceSummary,
} from '@/lib/services/customers';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createCustomerSchema } from '@/lib/validation/customers';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[customers] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    if (searchParams.get('balanceSummary') === 'true') {
      const summary = await customerBalanceSummary(ctx);
      return NextResponse.json(summary);
    }

    const includeInactive = searchParams.get('includeInactive') === 'true';
    const list = await listCustomers(ctx, { includeInactive });
    return NextResponse.json(list);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createCustomerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const customer = await createCustomer(ctx, parsed.data);
    return NextResponse.json(customer, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
