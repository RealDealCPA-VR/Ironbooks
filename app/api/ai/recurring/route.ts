/**
 * GET  /api/ai/recurring → { suggestions: RecurringSuggestion[] } — detected, not-yet-memorized
 *      recurring bills/expenses.
 * POST /api/ai/recurring { docType, sourceDocId, frequency, nextRunDate, name, autoEnter? }
 *      → 201 { template } — memorize via the normal recurring-template service (default
 *      remind-only).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { detectRecurring, memorizeSuggestion } from '@/lib/services/aiRecurring';
import { zodErrorBody } from '@/lib/validation/helpers';
import { memorizeSuggestionSchema } from '@/lib/validation/ai';
import { aiErrorResponse } from '../_errors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ suggestions: await detectRecurring(ctx) });
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/recurring');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = memorizeSuggestionSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const template = await memorizeSuggestion(ctx, parsed.data);
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/recurring');
  }
}
