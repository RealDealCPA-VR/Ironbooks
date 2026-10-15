/**
 * POST /api/bank-rules/run { bankAccountId } → { applied, skipped }
 * Posts every unreviewed line whose first matching rule is set to "Add automatically".
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { runAutoRules } from '@/lib/services/bankSuggest';

const schema = z.object({ bankAccountId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await runAutoRules(ctx, parsed.data.bankAccountId));
  } catch (err) {
    return routeError(err, 'POST /api/bank-rules/run');
  }
}
