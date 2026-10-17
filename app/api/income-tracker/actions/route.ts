/**
 * POST /api/income-tracker/actions — batch actions on Income Tracker rows (wave2 sales C9).
 * Body: { action: 'email' | 'queue_print' | 'queue_email' | 'convert', items: [{ type, id }],
 *         overrideCreditLimit? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { runTrackerAction, type TrackerAction } from '@/lib/services/incomeTracker';
import { routeError, requireJsonObject } from '@/lib/routeErrors';

const ACTIONS: TrackerAction[] = ['email', 'queue_print', 'queue_email', 'convert'];

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req, { optional: true })) as Record<string, unknown>;
    if (!ACTIONS.includes(body.action as TrackerAction)) {
      return NextResponse.json({ error: 'Unknown action.', code: 'VALIDATION' }, { status: 400 });
    }
    const items = (Array.isArray(body.items) ? body.items : []).filter(
      (i): i is { type: string; id: string } =>
        !!i && typeof (i as { type?: unknown }).type === 'string' && typeof (i as { id?: unknown }).id === 'string',
    );
    return NextResponse.json(
      await runTrackerAction(ctx, body.action as TrackerAction, items, {
        overrideCreditLimit: body.overrideCreditLimit === true,
      }),
    );
  } catch (err) {
    return routeError(err, 'POST /api/income-tracker/actions');
  }
}
