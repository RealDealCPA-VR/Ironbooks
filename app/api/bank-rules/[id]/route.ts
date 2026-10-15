/**
 * GET    /api/bank-rules/:id → BankRule
 * PUT    /api/bank-rules/:id → update (partial). Record locking: send `expectedUpdatedAt` (or the
 *        x-expected-updated-at header) with the version you loaded; a stale save answers 409.
 * DELETE /api/bank-rules/:id → delete (kept for the audit trail)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { expectedVersion } from '@/lib/services/concurrency';
import { deleteBankRule, getBankRule, updateBankRule, type BankRuleInput } from '@/lib/services/bankRules';
import { ruleUpdateSchema } from '@/lib/bankRules/schemas';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    return NextResponse.json(await getBankRule(ctx, id));
  } catch (err) {
    return routeError(err, 'GET /api/bank-rules/[id]');
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const parsed = ruleUpdateSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const { expectedUpdatedAt, ...rest } = parsed.data;
    const version = expectedUpdatedAt ?? expectedVersion(req)?.toISOString() ?? null;
    return NextResponse.json(await updateBankRule(ctx, id, rest as Partial<BankRuleInput>, version));
  } catch (err) {
    return routeError(err, 'PUT /api/bank-rules/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteBankRule(ctx, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return routeError(err, 'DELETE /api/bank-rules/[id]');
  }
}
