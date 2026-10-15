/**
 * Accountant side of an Accountant's Copy.
 * GET  /api/accountant-copy/changes          → the changes made in this copy so far
 * POST /api/accountant-copy/changes { note } → the .ibcx changes file for the client
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { fileResponse } from '@/lib/fileDownload';
import { readJsonObject, routeError } from '@/lib/routeErrors';
import { accountantChanges, exportChangesFile } from '@/lib/services/accountantCopy/accountant';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await accountantChanges(ctx));
  } catch (err) {
    return routeError(err, '/api/accountant-copy/changes');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await readJsonObject(req)) ?? {};
    const res = await exportChangesFile(ctx, { note: typeof body.note === 'string' ? body.note : null });
    return fileResponse(res.buffer, res.filename);
  } catch (err) {
    return routeError(err, '/api/accountant-copy/changes');
  }
}
