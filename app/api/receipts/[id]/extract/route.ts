/**
 * POST /api/receipts/[id]/extract  { force?: boolean, version?: number }
 * Read the receipt on this machine now (PDF text / offline OCR / the company's local vision
 * model). Without `force` only an unread or failed receipt is read; `force` re-reads one that was
 * already read and must name the version on screen. Answers with the receipt as it stands (still
 * "processing" when another reader is busy with it — poll GET /api/receipts/[id]).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { readJsonObject, routeError } from '@/lib/routeErrors';
import { extractReceipt } from '@/lib/services/receipts';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = (await readJsonObject(req)) ?? {};
    const receipt = await extractReceipt(ctx, id, {
      force: body.force === true,
      version: typeof body.version === 'number' ? body.version : undefined,
    });
    return NextResponse.json({ receipt });
  } catch (err) {
    return routeError(err, 'POST /api/receipts/[id]/extract');
  }
}
