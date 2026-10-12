/**
 * PATCH  /api/notes/:id — edit a note { body?, noteDate? }
 * DELETE /api/notes/:id — delete a note
 * ('member' route: the area is that of the record the note belongs to — checked here.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { requirePermission } from '@/lib/services/access';
import { deleteNote, getNote, updateNote, type NoteEntityType } from '@/lib/services/lists/notes';
import { NOTE_AREA } from '@/lib/lists/noteAreas';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const note = await getNote(ctx, id);
    requirePermission(ctx, NOTE_AREA[note.entityType as NoteEntityType] ?? 'lists', 'modify');
    return NextResponse.json(await updateNote(ctx, id, await req.json().catch(() => ({}))));
  } catch (err) {
    return routeError(err, 'PATCH /api/notes/:id');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const note = await getNote(ctx, id);
    requirePermission(ctx, NOTE_AREA[note.entityType as NoteEntityType] ?? 'lists', 'modify');
    return NextResponse.json(await deleteNote(ctx, id));
  } catch (err) {
    return routeError(err, 'DELETE /api/notes/:id');
  }
}
