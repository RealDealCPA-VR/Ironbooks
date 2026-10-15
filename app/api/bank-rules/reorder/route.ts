/** POST /api/bank-rules/reorder { orderedIds } → { rules } — the first id is checked first. */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { reorderBankRules } from '@/lib/services/bankRules';
import { reorderSchema } from '@/lib/bankRules/schemas';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = reorderSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json({ rules: await reorderBankRules(ctx, parsed.data.orderedIds) });
  } catch (err) {
    return routeError(err, 'POST /api/bank-rules/reorder');
  }
}
