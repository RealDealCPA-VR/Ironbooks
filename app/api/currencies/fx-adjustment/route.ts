/**
 * POST /api/currencies/fx-adjustment
 *
 * Record an FX gain or loss as a balanced journal entry.
 * Body: { accountId, amount, gain, date, memo? }
 *
 *   gain=true  → Dr accountId / Cr Exchange Gain/Loss
 *   gain=false → Dr Exchange Gain/Loss / Cr accountId
 *
 * On a foreign-currency bank / card account the entry changes the home value only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { recordFxAdjustment } from '@/lib/services/currencies';
import { routeError, requireJsonObject } from '@/lib/routeErrors';
import { parseDateInput } from '@/lib/validation/helpers';

const bad = (error: string) => NextResponse.json({ error, code: 'VALIDATION' }, { status: 400 });

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);
    const { accountId, amount, gain, date, memo } = body as {
      accountId: unknown;
      amount: unknown;
      gain: unknown;
      date: unknown;
      memo?: unknown;
    };

    if (!accountId || typeof accountId !== 'string') return bad('accountId is required');
    if (amount === undefined || amount === null || amount === '') return bad('amount is required');
    if (typeof amount !== 'string' && typeof amount !== 'number') return bad('amount must be a number');
    // review5 fx: `gain` must really be a boolean — Boolean("false") is true, which posted a loss
    // as a gain.
    if (typeof gain !== 'boolean') return bad('gain must be true (FX gain) or false (FX loss)');
    if (!date || typeof date !== 'string') return bad('date is required');
    const when = parseDateInput(date);
    if (!when) return bad(`"${date}" is not a valid date`);
    if (memo != null && typeof memo !== 'string') return bad('memo must be text');

    const result = await recordFxAdjustment(ctx, {
      accountId,
      amount,
      gain,
      date: when,
      memo: memo ?? undefined,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/currencies/fx-adjustment');
  }
}
