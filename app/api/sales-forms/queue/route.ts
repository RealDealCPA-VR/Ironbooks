/**
 * GET  /api/sales-forms/queue?mode=print|email — forms waiting to be printed / emailed.
 * POST /api/sales-forms/queue — { action: 'mark_printed' | 'send_emails', items: [{ kind, id, to? }] }
 * (wave2 sales C7: QB Print Forms / Send Forms).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  isSalesFormKind,
  listSendQueue,
  markPrinted,
  sendQueuedEmails,
  type SalesFormKind,
} from '@/lib/services/salesForms';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const mode = req.nextUrl.searchParams.get('mode') === 'email' ? 'email' : 'print';
    return NextResponse.json({ mode, items: await listSendQueue(ctx, mode) });
  } catch (err) {
    return routeError(err, 'GET /api/sales-forms/queue');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as { action?: unknown; items?: unknown };
    const raw = Array.isArray(body.items) ? body.items : [];
    const items: Array<{ kind: SalesFormKind; id: string; to?: string | null }> = [];
    for (const it of raw as Array<Record<string, unknown>>) {
      if (!it || !isSalesFormKind(it.kind) || typeof it.id !== 'string') {
        return NextResponse.json({ error: 'Each item needs a valid kind and id.', code: 'VALIDATION' }, { status: 400 });
      }
      items.push({ kind: it.kind, id: it.id, to: typeof it.to === 'string' ? it.to : null });
    }
    if (items.length === 0) {
      return NextResponse.json({ error: 'Select at least one form.', code: 'VALIDATION' }, { status: 400 });
    }
    if (body.action === 'mark_printed') return NextResponse.json(await markPrinted(ctx, items));
    if (body.action === 'send_emails') return NextResponse.json(await sendQueuedEmails(ctx, items));
    return NextResponse.json(
      { error: 'Unknown action. Use mark_printed or send_emails.', code: 'VALIDATION' },
      { status: 400 },
    );
  } catch (err) {
    return routeError(err, 'POST /api/sales-forms/queue');
  }
}
