/**
 * Working Trial Balance.
 * GET  /api/accountant/working-trial-balance?from=&to=  → rows (beginning / transactions /
 *      adjustments / ending, workpaper ref, notes)
 * PUT  { accountId, periodEnd, workpaperRef?, note? }    → save workpaper ref / note
 * POST { date, description, reference?, lines[] }        → post an adjusting journal entry
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { ServiceError } from '@/lib/services/_base';
import {
  postAdjustingEntry,
  saveWtbNote,
  workingTrialBalance,
} from '@/lib/services/accountant/workingTrialBalance';
import { zodErrorBody } from '@/lib/validation/helpers';
import { adjustingEntrySchema, wtbNoteSchema } from '@/lib/validation/accountant';
import { dayParam } from '../_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const from = dayParam(sp.get('from'), 'from');
    const to = dayParam(sp.get('to'), 'to', true);
    if (!from || !to) throw new ServiceError('VALIDATION', 'Choose the period (from and to).');
    return NextResponse.json(await workingTrialBalance(ctx, { from, to }));
  } catch (err) {
    return routeError(err, '/api/accountant/working-trial-balance');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = wtbNoteSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await saveWtbNote(ctx, parsed.data));
  } catch (err) {
    return routeError(err, '/api/accountant/working-trial-balance');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = adjustingEntrySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await postAdjustingEntry(ctx, parsed.data), { status: 201 });
  } catch (err) {
    return routeError(err, '/api/accountant/working-trial-balance');
  }
}
