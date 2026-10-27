/**
 * GET    /api/attachments/[id]  — download the file (sets Content-Disposition + Content-Type).
 *                                 ?inline=1 opens it in the viewer instead of downloading.
 * PATCH  /api/attachments/[id]  — Doc Center: attach to a record { entityType, entityId }, unfile
 *                                 it back to the inbox (both null), or set { description }.
 * DELETE /api/attachments/[id]  — delete the attachment row and file from disk.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getAttachmentFile, deleteAttachment, updateAttachment } from '@/lib/services/attachments';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateAttachmentSchema } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

/** Types safe to show inline in the app window (no HTML/SVG/script content). */
const INLINE_SAFE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/i;

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const { filename, mimeType, buffer } = await getAttachmentFile(ctx, id);

    // getAttachmentFile only returns a header-safe type (lib/services/attachments.ts safeMimeType).
    const type = mimeType ?? 'application/octet-stream';
    const inline = req.nextUrl.searchParams.get('inline') === '1' && INLINE_SAFE.test(type);
    const headers = new Headers();
    headers.set('Content-Type', type);
    headers.set(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`,
    );
    headers.set('Content-Length', String(buffer.length));
    headers.set('X-Content-Type-Options', 'nosniff');

    return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
  } catch (err) {
    return routeError(err, 'GET /api/attachments/[id]');
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = updateAttachmentSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateAttachment(ctx, id, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/attachments/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteAttachment(ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return routeError(err, 'DELETE /api/attachments/[id]');
  }
}
