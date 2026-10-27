/**
 * GET  /api/recurring        — list recurring templates for this company
 * POST /api/recurring        — create a new recurring template
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listTemplates, createTemplate, todayUtcMidnight } from '@/lib/services/recurring';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createRecurringTemplateSchema } from '@/lib/validation/recurring';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[recurring/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const templates = await listTemplates(ctx);
    return NextResponse.json(templates);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createRecurringTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }

    const tpl = await createTemplate(ctx, {
      ...parsed.data,
      // No date: today on this computer's calendar (a ledger date), never the current instant.
      nextRunDate: parsed.data.nextRunDate ?? todayUtcMidnight(),
      // mode wins; legacy autoEnter (default true) maps to automatic / remind.
      autoEnter: parsed.data.autoEnter ?? true,
    });

    return NextResponse.json(tpl, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
