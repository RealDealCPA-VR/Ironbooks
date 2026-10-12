/**
 * GET  /api/notes?entityType=customer|vendor|employee|other_name&entityId=<id> — dated notes
 * POST /api/notes — add a note { entityType, entityId, body, noteDate? }
 *
 * Mapped as 'member' in lib/permissions/routes.ts: the area depends on the record the note
 * belongs to, so the handler checks it (customers / vendors / payroll / lists).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { requirePermission } from '@/lib/services/access';
import { addNote, listNotes, type NoteEntityType } from '@/lib/services/lists/notes';
import { NOTE_ENTITY_TYPES } from '@/lib/validation/lists';
import { NOTE_AREA } from '@/lib/lists/noteAreas';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const entityType = sp.get('entityType') ?? '';
    const entityId = sp.get('entityId') ?? '';
    if (!(NOTE_ENTITY_TYPES as readonly string[]).includes(entityType) || !/^[0-9a-f-]{36}$/i.test(entityId)) {
      return NextResponse.json({ error: 'entityType and entityId are required', code: 'VALIDATION' }, { status: 400 });
    }
    const ctx = await getServerContext();
    requirePermission(ctx, NOTE_AREA[entityType as NoteEntityType], 'view');
    return NextResponse.json({ notes: await listNotes(ctx, entityType as NoteEntityType, entityId) });
  } catch (err) {
    return routeError(err, 'GET /api/notes');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as { entityType?: string };
    const area = NOTE_AREA[body.entityType as NoteEntityType];
    if (!area) return NextResponse.json({ error: 'Unknown entity type', code: 'VALIDATION' }, { status: 400 });
    requirePermission(ctx, area, 'modify');
    return NextResponse.json(await addNote(ctx, body), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/notes');
  }
}
