/**
 * POST /api/leads/:id/convert — turn the lead into a customer { displayName? }
 *   returns { lead, customerId }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { convertLeadToCustomer } from '@/lib/services/leads';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { convertLeadSchema } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = convertLeadSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await convertLeadToCustomer(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'POST /api/leads/[id]/convert');
  }
}
