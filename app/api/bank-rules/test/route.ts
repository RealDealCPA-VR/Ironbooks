/**
 * POST /api/bank-rules/test { ...rule draft, id?, days? } → { checked, hits }
 * Read-only: lists the recent bank lines the rule would catch (and any higher-priority rule that
 * would take a line first). Nothing is changed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { testBankRule, type BankRuleInput } from '@/lib/services/bankRules';
import { ruleTestSchema } from '@/lib/bankRules/schemas';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = ruleTestSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { days, ...draft } = parsed.data;
    return NextResponse.json(await testBankRule(ctx, draft as BankRuleInput & { id?: string | null }, { days }));
  } catch (err) {
    return routeError(err, 'POST /api/bank-rules/test');
  }
}
