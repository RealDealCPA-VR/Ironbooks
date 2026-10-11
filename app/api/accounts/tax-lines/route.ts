/**
 * GET /api/accounts/tax-lines  — the company's income-tax form + account → tax-line mapping
 *                                (getTaxLineMapping; feeds the income-tax reports).
 * PUT /api/accounts/tax-lines  — set the company's income-tax form: { form: '1120' | '1120S' |
 *                                '1065' | 'SCHC' | null }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { getTaxLineMapping, setIncomeTaxForm } from '@/lib/services/accounts';
import { zodErrorBody } from '@/lib/validation/helpers';
import { incomeTaxFormSchema } from '@/lib/validation/accounts';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getTaxLineMapping(ctx));
  } catch (err) {
    return routeError(err, 'accounts/tax-lines');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = incomeTaxFormSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const form = await setIncomeTaxForm(ctx, parsed.data.form);
    return NextResponse.json({ form });
  } catch (err) {
    return routeError(err, 'accounts/tax-lines');
  }
}
