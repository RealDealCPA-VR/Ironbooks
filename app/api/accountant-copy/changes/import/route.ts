/**
 * POST /api/accountant-copy/changes/import — body: the accountant's .ibcx changes file (its JSON).
 * Applies every change through the normal services in one transaction, then removes the
 * Accountant's Copy restriction. Changes dated on or before the closing date need the
 * closing-date password (x-closing-password), like any other edit of a closed period.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { importChangesFile } from '@/lib/services/accountantCopy/client';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const buffer = Buffer.from(await req.arrayBuffer());
    if (!buffer.byteLength) {
      return NextResponse.json({ error: 'Choose the changes file first.', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(await importChangesFile(ctx, buffer));
  } catch (err) {
    return routeError(err, '/api/accountant-copy/changes/import');
  }
}
