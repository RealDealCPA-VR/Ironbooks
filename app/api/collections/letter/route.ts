/**
 * POST /api/collections/letter — a collection letter PDF for one customer (from a Letters
 * template), recorded as a letter contact in the Collections Center (C9).
 * Body: { customerId, templateId, signer?, followUpDate?, addTodo? }. Returns the PDF.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { collectionLetter } from '@/lib/services/collections';
import { pdfResponse, requireJsonObject, routeError } from '@/lib/routeErrors';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const b = await requireJsonObject(req);
    const templateId = str(b.templateId);
    if (!templateId) {
      return NextResponse.json({ error: 'Pick a letter template.', code: 'VALIDATION' }, { status: 400 });
    }
    const { bytes } = await collectionLetter(ctx, {
      customerId: typeof b.customerId === 'string' ? b.customerId : '',
      templateId,
      signer: str(b.signer),
      followUpDate: str(b.followUpDate),
      addTodo: b.addTodo === true,
    });
    return pdfResponse(bytes, 'collection-letter.pdf');
  } catch (err) {
    return routeError(err, 'POST /api/collections/letter');
  }
}
