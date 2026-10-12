/**
 * POST /api/banking/account-currency { accountId, currency } — set the currency of a bank or
 * credit-card account (only while the account has no transactions).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { setAccountCurrency } from '@/lib/services/currencies';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { accountCurrencySchema } from '@/lib/validation/purchases';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = accountCurrencySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await setAccountCurrency(ctx, parsed.data.accountId, parsed.data.currency ?? null));
  } catch (err) {
    return routeError(err, 'POST /api/banking/account-currency');
  }
}
