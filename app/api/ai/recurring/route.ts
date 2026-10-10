/**
 * GET  /api/ai/recurring → { suggestions: RecurringSuggestion[] } — detected, not-yet-memorized
 *      recurring bills/expenses.
 * POST /api/ai/recurring { docType, sourceDocId, frequency, nextRunDate, name, autoEnter? }
 *      → 201 { template } — memorize via the normal recurring-template service (default
 *      remind-only).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { detectRecurring, memorizeSuggestion } from '@/lib/services/aiRecurring';
import { zodErrorBody } from '@/lib/validation/helpers';
import { aiErrorResponse } from '../_errors';

const memorizeSchema = z.object({
  docType: z.enum(['bill', 'expense']),
  sourceDocId: z.string().uuid(),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  nextRunDate: z.string().refine((s) => !isNaN(new Date(s).getTime()), 'invalid date'),
  name: z.string().trim().min(1).max(255),
  autoEnter: z.boolean().optional(),
});

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
    const parsed = memorizeSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const template = await memorizeSuggestion(ctx, parsed.data);
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/recurring');
  }
}
