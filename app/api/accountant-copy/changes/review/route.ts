/**
 * POST /api/accountant-copy/changes/review — body: the accountant's .ibcx changes file (its JSON).
 * Returns the plain-language review of every change; nothing is changed.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { reviewChangesFile } from '@/lib/services/accountantCopy/client';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const buffer = Buffer.from(await req.arrayBuffer());
    if (!buffer.byteLength) {
      return NextResponse.json({ error: 'Choose the changes file first.', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(await reviewChangesFile(ctx, buffer));
  } catch (err) {
    return routeError(err, '/api/accountant-copy/changes/review');
  }
}
