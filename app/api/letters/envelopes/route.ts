/**
 * POST /api/letters/envelopes — #10 envelopes { recipientType, recipientIds, includeReturnAddress? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requirePermission } from '@/lib/services/access';
import { envelopesPdf } from '@/lib/services/letters';
import { pdfResponse, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { envelopesSchema } from '@/lib/validation/prefs';
import { RECIPIENT_AREA } from '../_shared';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = envelopesSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    requirePermission(ctx, RECIPIENT_AREA[parsed.data.recipientType], 'print');
    return pdfResponse(await envelopesPdf(ctx, parsed.data), 'envelopes.pdf');
  } catch (err) {
    return routeError(err, 'POST /api/letters/envelopes');
  }
}
