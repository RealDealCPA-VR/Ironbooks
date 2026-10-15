/**
 * API route: /api/expenses — Write Checks / direct expenses / credit card charges.
 *
 * GET  /api/expenses[?vendorId=&otherNameId=&method=&paymentAccountId=&toPrint=true&includeVoided=true&limit=&offset=]
 *   → 200 { expenses: Expense[] }   (vendorName/paymentAccountName joined in)
 *
 * POST /api/expenses
 *   Body: {
 *     vendorId?:        string,
 *     otherNameId?:     string,              // payee from the Other Names list (not with vendorId)
 *     payeeName?:       string,              // required when no vendorId / otherNameId
 *     date:             string (ISO),
 *     method:           'check'|'cash'|'credit_card',
 *     reference?:       string,              // check no.; auto-assigned when omitted (method=check)
 *     paymentAccountId: string,              // bank/cash or credit-card account
 *     memo?:            string,
 *     toPrint?:         boolean,             // queue for Print Checks (method=check)
 *     isRefund?:        boolean,             // credit-card credit
 *     lines: Array<{ accountId, description?, amount, classId?, customerId?, jobId? }>
 *   }
 *   → 201 { expense: Expense }
 */
import { NextRequest, NextResponse } from 'next/server';
import { zodErrorWithFixes } from '@/lib/fixRoutes';
import { serviceErrorBody } from '@/lib/routeErrors';
import { getServerContext } from '@/lib/context';
import {
  createExpense,
  listExpenses,
  type ExpenseMethod,
} from '@/lib/services/expenses';
import { ServiceError } from '@/lib/services/_base';
import { createExpenseSchema } from '@/lib/validation/expenses';

function errorStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'VALIDATION':
    case 'UNBALANCED':
    case 'PERIOD_CLOSED':
      return 400;
    case 'FORBIDDEN':
      return 403;
    case 'CONFLICT':
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, route: string) {
  if (err instanceof ServiceError) {
    return NextResponse.json(
      { ...serviceErrorBody(err), details: err.details ?? null },
      { status: errorStatus(err.code) },
    );
  }
  console.error(`[${route}]`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const { searchParams } = req.nextUrl;

    const method = searchParams.get('method') ?? undefined;
    const rows = await listExpenses(ctx, {
      vendorId: searchParams.get('vendorId') ?? undefined,
      otherNameId: /^[0-9a-f-]{36}$/i.test(searchParams.get('otherNameId') ?? '') ? searchParams.get('otherNameId')! : undefined,
      method: method as ExpenseMethod | undefined,
      paymentAccountId: searchParams.get('paymentAccountId') ?? undefined,
      toPrint: searchParams.get('toPrint') === 'true' || undefined,
      includeVoided: searchParams.get('includeVoided') === 'true',
      limit: searchParams.has('limit') ? Number(searchParams.get('limit')) : undefined,
      offset: searchParams.has('offset') ? Number(searchParams.get('offset')) : undefined,
    });
    return NextResponse.json({ expenses: rows });
  } catch (err) {
    return errorResponse(err, 'GET /api/expenses');
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createExpenseSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorWithFixes(ctx, parsed.error, body, 'expense');
    }

    // QB duplicate check-number warning: refused (409, details.duplicateNumber) unless confirmed.
    const { allowDuplicateNumber, ...input } = parsed.data;
    const expense = await createExpense(ctx, { ...input, checkDuplicateNumber: !allowDuplicateNumber });

    return NextResponse.json({ expense }, { status: 201 });
  } catch (err) {
    return errorResponse(err, 'POST /api/expenses');
  }
}
