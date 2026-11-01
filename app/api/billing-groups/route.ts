/**
 * GET  /api/billing-groups — every Billing Group with its customers (C6, Batch Invoicing).
 * POST /api/billing-groups — { name, customerIds? } create a group.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createBillingGroup, listBillingGroups } from '@/lib/services/billingGroups';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ groups: await listBillingGroups(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/billing-groups');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    return NextResponse.json(await createBillingGroup(ctx, { name: body.name, customerIds: body.customerIds }), {
      status: 201,
    });
  } catch (err) {
    return routeError(err, 'POST /api/billing-groups');
  }
}
