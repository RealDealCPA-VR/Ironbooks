/**
 * Doc Center.
 * GET  /api/attachments?entityType=&entityId=  — documents attached to one record
 * GET  /api/attachments?unfiled=1              — the inbox (documents not attached to anything)
 * GET  /api/attachments?all=1[&q=text]         — every document, optionally searched by name/description
 * POST /api/attachments                        — upload { filename, mimeType, base64, description?,
 *                                                entityType?, entityId? } (omit both to leave it unfiled)
 * Files are stored locally in the company data directory.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  listAttachments,
  listUnfiledAttachments,
  saveAttachment,
  searchAttachments,
} from '@/lib/services/attachments';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { uploadAttachmentSchema } from '@/lib/validation/prefs';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;
    if (searchParams.get('unfiled') === '1') {
      return NextResponse.json(await listUnfiledAttachments(ctx));
    }
    if (searchParams.get('all') === '1') {
      return NextResponse.json(await searchAttachments(ctx, { q: searchParams.get('q') ?? undefined }));
    }
    const entityType = searchParams.get('entityType') ?? '';
    const entityId = searchParams.get('entityId') ?? '';

    if (!entityType || !entityId) {
      return NextResponse.json(
        { error: 'entityType and entityId query params are required', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const list = await listAttachments(ctx, { entityType, entityId });
    return NextResponse.json(list);
  } catch (err) {
    return routeError(err, 'GET /api/attachments');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = uploadAttachmentSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { entityType, entityId, filename, mimeType, base64, description } = parsed.data;
    const row = await saveAttachment(ctx, {
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      filename,
      mimeType: mimeType ?? 'application/octet-stream',
      base64,
      description: description ?? null,
    });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/attachments');
  }
}
