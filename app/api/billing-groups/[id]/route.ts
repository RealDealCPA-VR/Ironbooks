/**
 * GET    /api/billing-groups/:id — one Billing Group with its customers (C6).
 * PATCH  /api/billing-groups/:id — { name?, customerIds? (replace), addCustomerIds? (add) }.
 * DELETE /api/billing-groups/:id — delete the group (its customers are untouched).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  addBillingGroupMembers,
  deleteBillingGroup,
  getBillingGroup,
  updateBillingGroup,
} from '@/lib/services/billingGroups';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getBillingGroup(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/billing-groups/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    if (body.addCustomerIds !== undefined) {
      if (body.name !== undefined) await updateBillingGroup(ctx, id, { name: body.name });
      return NextResponse.json(await addBillingGroupMembers(ctx, id, body.addCustomerIds));
    }
    return NextResponse.json(await updateBillingGroup(ctx, id, { name: body.name, customerIds: body.customerIds }));
  } catch (err) {
    return routeError(err, 'PATCH /api/billing-groups/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await deleteBillingGroup(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/billing-groups/[id]');
  }
}
