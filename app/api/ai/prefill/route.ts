/**
 * GET /api/ai/prefill?vendorId=<uuid>  or  ?payee=<name>[&amount=<decimal>]
 *   → PrefillResult { source: 'vendor-default'|'last-used'|'learned'|'none', lines[] }
 * QB "pre-fill accounts for vendor" for Bills / Write Checks / Expenses.
 *
 * Optional: &ai=1 also asks the AI when the payee has no history at all (source 'ai', with a
 * one-sentence `reason`); &direction=out|in says whether money left or arrived, and
 * &sourceAccountId=<uuid> names the bank / card / register account it moved through (never
 * suggested). AI off or unreachable is not an error: the answer is 'none' with `aiUnavailable`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getServerContext } from '@/lib/context';
import { accounts } from '@/lib/db/schema';
import { suggestAccountForPayee, vendorPrefill } from '@/lib/services/aiCategorizer';
import { aiErrorResponse } from '../_errors';

const isUuid = (v: string | null) => !v || z.string().uuid().safeParse(v).success;

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const vendorId = sp.get('vendorId') || null;
    const payee = sp.get('payee')?.slice(0, 255) || null;
    const amount = sp.get('amount');
    const sourceAccountId = sp.get('sourceAccountId') || null;
    if (!isUuid(vendorId)) return NextResponse.json({ error: 'vendorId must be a uuid.' }, { status: 400 });
    if (!isUuid(sourceAccountId)) return NextResponse.json({ error: 'sourceAccountId must be a uuid.' }, { status: 400 });
    if (!vendorId && !payee) return NextResponse.json({ source: 'none', lines: [] });
    const safeAmount = amount && /^-?\d+(\.\d{1,2})?$/.test(amount) ? amount : null;
    const direction = sp.get('direction') === 'in' ? 'in' : 'out';

    if (sp.get('ai') !== '1') {
      return NextResponse.json(await vendorPrefill(ctx, { vendorId, payee, amount: safeAmount, direction }));
    }
    // The account the money moved through, named in the AI prompt ("paid OUT of Visa Card").
    const [source] = sourceAccountId
      ? await ctx.db
          .select({ name: accounts.name })
          .from(accounts)
          .where(and(eq(accounts.id, sourceAccountId), eq(accounts.companyId, ctx.companyId)))
      : [];
    return NextResponse.json(
      await suggestAccountForPayee(ctx, {
        vendorId,
        payee,
        amount: safeAmount,
        direction,
        sourceAccountId: source ? sourceAccountId : null,
        sourceLabel: source?.name,
        ai: true,
      }),
    );
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/prefill');
  }
}
