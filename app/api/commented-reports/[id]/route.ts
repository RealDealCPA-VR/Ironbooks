/**
 * GET    /api/commented-reports/[id] — the commented report (snapshot + comments)
 * PATCH  /api/commented-reports/[id] — rename it or change its comments ({ name?, comments? })
 * DELETE /api/commented-reports/[id] — delete it
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteCommentedReport, getCommentedReport, updateCommentedReport } from '@/lib/services/commentedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateCommentedReportSchema } from '@/lib/validation/reports';
import { requireJsonObject } from '@/lib/routeErrors';
import { reportError } from '../../reports/_lib';

type P = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function idOf(params: P['params']): Promise<string | null> {
  const { id } = await params;
  return UUID_RE.test(id) ? id : null;
}

const NOT_FOUND = () => NextResponse.json({ error: 'Commented report not found.', code: 'NOT_FOUND' }, { status: 404 });

export async function GET(_req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    const id = await idOf(params);
    if (!id) return NOT_FOUND();
    return NextResponse.json(await getCommentedReport(ctx, id));
  } catch (e) {
    return reportError(e, 'commented-reports/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    const id = await idOf(params);
    if (!id) return NOT_FOUND();
    const parsed = updateCommentedReportSchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateCommentedReport(ctx, id, parsed.data));
  } catch (e) {
    return reportError(e, 'commented-reports/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: P) {
  try {
    const ctx = await getServerContext();
    const id = await idOf(params);
    if (!id) return NOT_FOUND();
    return NextResponse.json(await deleteCommentedReport(ctx, id));
  } catch (e) {
    return reportError(e, 'commented-reports/[id]');
  }
}
