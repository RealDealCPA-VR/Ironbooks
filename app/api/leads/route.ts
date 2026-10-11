/**
 * GET  /api/leads[?includeConverted=1] — Lead Center list
 * POST /api/leads — create a lead
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createLead, listLeads } from '@/lib/services/leads';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createLeadSchema } from '@/lib/validation/prefs';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(
      await listLeads(ctx, { includeConverted: req.nextUrl.searchParams.get('includeConverted') === '1' }),
    );
  } catch (err) {
    return routeError(err, 'GET /api/leads');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = createLeadSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createLead(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/leads');
  }
}
