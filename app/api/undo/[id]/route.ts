/**
 * POST /api/undo/:token -> { message, newId?, copy?, ... }
 *
 * The toast's "Undo" button. Applies the inverse of the action through the normal services
 * (ledger guards, closing date, record locking, audit trail). Refused with a plain message when
 * the token is someone else's, already used, older than 30 seconds, or the record changed since.
 * Member route: lib/services/undo.ts checks the permission of the inverse action itself
 * (e.g. undoing a new invoice needs permission to void invoices).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { performUndo } from '@/lib/services/undo';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await performUndo(ctx, id));
  } catch (err) {
    return routeError(err, 'POST /api/undo/[id]');
  }
}
