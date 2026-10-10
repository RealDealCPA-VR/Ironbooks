/**
 * GET  /api/ai/bank-suggestions?bankAccountId=<uuid>
 *   → { suggestions: BankSuggestion[], threshold, autoApplyEnabled, trainedOn }
 *   Learned-categorizer suggestion per unreviewed feed line (rules win; source 'rule'|'model').
 *
 * POST /api/ai/bank-suggestions
 *   { action: 'auto-apply', bankAccountId } → AutoApplyResult — posts lines at/above the
 *       company threshold through the normal categorize service.
 *   { action: 'llm', bankTransactionId }   → LlmCategorySuggestion — ask the AI router for a
 *       second opinion on a low-confidence line (existing accounts only; nothing is posted).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import {
  autoApplyBankSuggestions,
  llmSuggestBankCategory,
  suggestBankCategories,
} from '@/lib/services/aiCategorizer';
import { zodErrorBody } from '@/lib/validation/helpers';
import { aiErrorResponse } from '../_errors';

const postSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('auto-apply'), bankAccountId: z.string().uuid() }),
  z.object({ action: z.literal('llm'), bankTransactionId: z.string().uuid() }),
]);

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const bankAccountId = req.nextUrl.searchParams.get('bankAccountId');
    if (!bankAccountId || !z.string().uuid().safeParse(bankAccountId).success) {
      return NextResponse.json({ error: 'bankAccountId query parameter is required.' }, { status: 400 });
    }
    return NextResponse.json(await suggestBankCategories(ctx, bankAccountId));
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/bank-suggestions');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    if (parsed.data.action === 'auto-apply') {
      return NextResponse.json(await autoApplyBankSuggestions(ctx, parsed.data.bankAccountId));
    }
    return NextResponse.json(await llmSuggestBankCategory(ctx, parsed.data.bankTransactionId));
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/bank-suggestions');
  }
}
