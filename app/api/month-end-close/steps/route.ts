/**
 * PATCH /api/month-end-close/steps
 *   Body: { periodEnd, stepKey, action: 'review' | 'unreview' | 'skip' | 'unskip',
 *           note?, reason? (required to skip), version? (record locking) }
 *   → the updated checklist. Audited.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { updateMonthEndStep } from '@/lib/services/monthEndClose';
import { zodErrorBody } from '@/lib/validation/helpers';
import { monthEndStepSchema } from '@/lib/validation/monthEndClose';

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const parsed = monthEndStepSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateMonthEndStep(ctx, parsed.data));
  } catch (err) {
    return routeError(err, '/api/month-end-close/steps');
  }
}
