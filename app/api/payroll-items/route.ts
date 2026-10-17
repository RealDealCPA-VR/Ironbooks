/**
 * GET  /api/payroll-items — list payroll items for the active company.
 *        ?includeInactive=true — include deactivated items.
 *        ?kind=earning|tax|deduction|employer_contribution|garnishment — filter.
 *      Seeds the QB-like default item set on first use (write roles only).
 * POST /api/payroll-items — create a payroll item.
 *        { name, kind, pretax?, expenseAccountId?, liabilityAccountId?, calcBasis?, defaultRate? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  PAYROLL_ITEM_KINDS,
  createPayrollItem,
  ensureDefaultPayrollItems,
  listPayrollItems,
  type PayrollItemKind,
} from '@/lib/services/payrollItems';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { createPayrollItemSchema } from '@/lib/validation/payrollItems';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[payroll-items] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    // Seed defaults on first use — skipped for viewers (read-only contexts can't write).
    if (ctx.role !== 'viewer') {
      await ensureDefaultPayrollItems(ctx);
    }
    const { searchParams } = req.nextUrl;
    const includeInactive = searchParams.get('includeInactive') === 'true';
    const kindParam = searchParams.get('kind');
    const kind =
      kindParam && PAYROLL_ITEM_KINDS.includes(kindParam as PayrollItemKind)
        ? (kindParam as PayrollItemKind)
        : undefined;
    const list = await listPayrollItems(ctx, { includeInactive, kind });
    return NextResponse.json(list);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createPayrollItemSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const item = await createPayrollItem(ctx, parsed.data);
    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
