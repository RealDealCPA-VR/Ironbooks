/**
 * GET  /api/memorized-reports/groups — list Memorized Report Groups
 * POST /api/memorized-reports/groups — create one ({ name })
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { createMemorizedGroup, listMemorizedGroups } from '@/lib/services/memorizedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { memorizedGroupSchema } from '@/lib/validation/reports';
import { reportError } from '../../reports/_lib';

export async function GET() {
  try {
    return NextResponse.json(await listMemorizedGroups(await getServerContext()));
  } catch (e) {
    return reportError(e, 'memorized-reports/groups');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = memorizedGroupSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await createMemorizedGroup(ctx, parsed.data), { status: 201 });
  } catch (e) {
    return reportError(e, 'memorized-reports/groups');
  }
}
