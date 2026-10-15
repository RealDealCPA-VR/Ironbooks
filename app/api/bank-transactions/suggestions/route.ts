/**
 * GET /api/bank-transactions/suggestions?bankAccountId=<uuid>[&ai=1]
 *   → { suggestions: LineSuggestion[], highConfidence: 90 }
 * One suggestion per unreviewed line with a confidence % and a plain-language reason, merged
 * from rules, your history and the AI categorizer. `ai=1` also asks the configured AI model
 * (through the AI router, only if one is set up) about low-confidence lines.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { suggestForAccount } from '@/lib/services/bankSuggest';
import { HIGH_CONFIDENCE } from '@/lib/bankRules/core';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const bankAccountId = req.nextUrl.searchParams.get('bankAccountId');
    if (!bankAccountId || !z.string().uuid().safeParse(bankAccountId).success) {
      return NextResponse.json(
        { error: 'bankAccountId query parameter is required.', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const ai = req.nextUrl.searchParams.get('ai') === '1';
    const suggestions = await suggestForAccount(ctx, bankAccountId, { ai });
    return NextResponse.json({ suggestions, highConfidence: HIGH_CONFIDENCE });
  } catch (err) {
    return routeError(err, 'GET /api/bank-transactions/suggestions');
  }
}
