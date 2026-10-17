/**
 * GET  /api/collections/notes?customerId= — collection notes for a customer.
 * POST /api/collections/notes — { customerId, invoiceId?, note, followUpDate? } (wave2 sales C9).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { addCollectionNote, listCollectionNotes } from '@/lib/services/incomeTracker';
import { routeError, requireJsonObject } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId');
    if (!customerId) {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json({ notes: await listCollectionNotes(ctx, customerId) });
  } catch (err) {
    return routeError(err, 'GET /api/collections/notes');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const b = (await requireJsonObject(req, { optional: true })) as Record<string, unknown>;
    if (typeof b.customerId !== 'string') {
      return NextResponse.json({ error: 'customerId is required', code: 'VALIDATION' }, { status: 400 });
    }
    const follow = typeof b.followUpDate === 'string' && b.followUpDate ? new Date(b.followUpDate) : null;
    if (follow && Number.isNaN(follow.getTime())) {
      return NextResponse.json({ error: 'followUpDate is not a valid date', code: 'VALIDATION' }, { status: 400 });
    }
    const note = await addCollectionNote(ctx, {
      customerId: b.customerId,
      invoiceId: typeof b.invoiceId === 'string' && b.invoiceId ? b.invoiceId : null,
      note: typeof b.note === 'string' ? b.note : '',
      followUpDate: follow,
    });
    return NextResponse.json(note, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/collections/notes');
  }
}
