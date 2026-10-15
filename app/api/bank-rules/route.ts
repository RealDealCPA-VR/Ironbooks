/**
 * GET  /api/bank-rules → { rules: BankRule[] } (in the order they are checked; incl. disabled)
 * POST /api/bank-rules → create a bank rule (conditions + actions + mode); 201 BankRule
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createBankRule, listBankRules, type BankRuleInput } from '@/lib/services/bankRules';
import { ruleBodySchema } from '@/lib/bankRules/schemas';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ rules: await listBankRules(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/bank-rules');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = ruleBodySchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const rule = await createBankRule(ctx, parsed.data as BankRuleInput);
    return NextResponse.json(rule, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/bank-rules');
  }
}
