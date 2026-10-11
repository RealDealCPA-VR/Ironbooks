/**
 * POST /api/letters/labels — Avery 5160 mailing labels { recipientType, recipientIds, startPosition? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requirePermission } from '@/lib/services/access';
import { labelsPdf } from '@/lib/services/letters';
import { pdfResponse, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { labelsSchema } from '@/lib/validation/prefs';
import { RECIPIENT_AREA } from '../_shared';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = labelsSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    requirePermission(ctx, RECIPIENT_AREA[parsed.data.recipientType], 'print');
    return pdfResponse(await labelsPdf(ctx, parsed.data), 'labels.pdf');
  } catch (err) {
    return routeError(err, 'POST /api/letters/labels');
  }
}
