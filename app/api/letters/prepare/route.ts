/**
 * POST /api/letters/prepare — merge a letter for each recipient.
 *   Body: { recipientType, recipientIds, templateId? | body?, signer?, date?, preview? }
 *   preview: true  returns the merged text as JSON (review before printing)
 *   otherwise      returns one PDF with a letter per recipient
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requirePermission } from '@/lib/services/access';
import { mergeLetters, prepareLettersPdf } from '@/lib/services/letters';
import { pdfResponse, routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { prepareLettersSchema } from '@/lib/validation/prefs';
import { RECIPIENT_AREA } from '../_shared';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = prepareLettersSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    requirePermission(ctx, RECIPIENT_AREA[parsed.data.recipientType], 'print');
    if (body && (body as Record<string, unknown>).preview === true) {
      return NextResponse.json(await mergeLetters(ctx, parsed.data));
    }
    return pdfResponse(await prepareLettersPdf(ctx, parsed.data), 'letters.pdf');
  } catch (err) {
    return routeError(err, 'POST /api/letters/prepare');
  }
}
