/**
 * PATCH  /api/memorized-reports/groups/[id] — rename ({ name })
 * DELETE /api/memorized-reports/groups/[id] — delete (reports are kept, ungrouped)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteMemorizedGroup, renameMemorizedGroup } from '@/lib/services/memorizedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { memorizedGroupSchema } from '@/lib/validation/reports';
import { reportError } from '../../../reports/_lib';

type P = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    const parsed = memorizedGroupSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await renameMemorizedGroup(ctx, (await params).id, parsed.data));
  } catch (e) {
    return reportError(e, 'memorized-reports/groups/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await deleteMemorizedGroup(ctx, (await params).id));
  } catch (e) {
    return reportError(e, 'memorized-reports/groups/[id]');
  }
}
