/**
 * GET  /api/company/setup-interview — the active company's interview record
 *                                     ({ status: 'done' | 'skipped', at, ... } or null).
 * POST /api/company/setup-interview — apply the EasyStep interview answers to the active company
 *                                     (lib/services/setupInterview.ts), or { skip: true } to
 *                                     record "Skip for now".
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import {
  applySetupInterview,
  getSetupInterview,
  setupInterviewSchema,
  skipSetupInterview,
} from '@/lib/services/setupInterview';
import { zodErrorBody } from '@/lib/validation/helpers';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getSetupInterview(ctx));
  } catch (err) {
    return routeError(err, 'company/setup-interview');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    if (body && body.skip === true) {
      return NextResponse.json(await skipSetupInterview(ctx));
    }
    const parsed = setupInterviewSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const result = await applySetupInterview(ctx, parsed.data);
    return NextResponse.json({
      summary: result.plan.summary,
      nextSteps: result.plan.nextSteps,
      accountsAdded: result.accountsAdded,
      taxLinesMapped: result.taxLinesMapped,
    });
  } catch (err) {
    return routeError(err, 'company/setup-interview');
  }
}
