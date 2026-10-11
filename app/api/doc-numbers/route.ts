/**
 * GET /api/doc-numbers            — per document type: starting number + next number
 *                                   (?docType=invoice returns just { nextNumber } for a form).
 * PUT /api/doc-numbers            — set / clear a starting number: { docType, startingNumber }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import {
  DOC_TYPES,
  getDocNumberSettings,
  isDocType,
  nextDocNumber,
  setStartingDocNumber,
} from '@/lib/services/docNumbers';
import { zodErrorBody } from '@/lib/validation/helpers';

const putSchema = z.object({
  docType: z.enum(DOC_TYPES),
  startingNumber: z.string().trim().max(50).nullable(),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const docType = req.nextUrl.searchParams.get('docType');
    if (docType) {
      if (!isDocType(docType)) {
        return NextResponse.json({ error: `Unknown document type "${docType}".` }, { status: 400 });
      }
      return NextResponse.json({ docType, nextNumber: await nextDocNumber(ctx, docType) });
    }
    return NextResponse.json({ settings: await getDocNumberSettings(ctx) });
  } catch (err) {
    return routeError(err, 'doc-numbers');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const setting = await setStartingDocNumber(
      ctx,
      parsed.data.docType,
      parsed.data.startingNumber || null,
    );
    return NextResponse.json({ setting });
  } catch (err) {
    return routeError(err, 'doc-numbers');
  }
}
