/**
 * GET    /api/credit-memos/:id              — fetch credit memo with lines
 * POST   /api/credit-memos/:id              — actions:
 *           { action: 'apply',  invoiceId, amount, date? }
 *           { action: 'refund', bankAccountId, amount, date?, memo? }
 *           { action: 'unapply', applicationId }      — undo one credit application (wave2 sales)
 * PUT/PATCH /api/credit-memos/:id           — edit the memo (void + re-post, wave2 sales C1)
 * DELETE /api/credit-memos/:id              — void the credit memo
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { expectedVersion, withVersionCheck } from '@/lib/services/concurrency';
import {
  getCreditMemo,
  applyToInvoice,
  refundCreditMemo,
  voidCreditMemo,
  updateCreditMemo,
  listCreditApplications,
  unapplyCreditApplication,
} from '@/lib/services/creditMemos';
import { ServiceError } from '@/lib/services/_base';
import { parseDateInput, zodErrorBody } from '@/lib/validation/helpers';
import { createCreditMemoSchema } from '@/lib/validation/creditMemos';
import { requireJsonObject, serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[credit-memos/[id]/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const memo = await getCreditMemo(ctx, id);
    const applications = await listCreditApplications(ctx, { creditMemoId: id });
    return NextResponse.json({ ...memo, applications });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    if (body.action === 'apply') {
      if (!body.invoiceId) {
        return NextResponse.json({ error: 'invoiceId is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (body.amount === undefined || body.amount === null) {
        return NextResponse.json({ error: 'amount is required', code: 'VALIDATION' }, { status: 400 });
      }

      // Optional application date; without it the service dates the application on the later of
      // the memo's and the invoice's dates.
      let date: Date | null = null;
      if (body.date != null && String(body.date).trim() !== '') {
        date = typeof body.date === 'string' ? parseDateInput(body.date) : null;
        if (!date) {
          return NextResponse.json({ error: `date: "${body.date}" is not a valid date`, code: 'VALIDATION' }, { status: 400 });
        }
      }

      const result = await applyToInvoice(ctx, {
        creditMemoId: id,
        invoiceId: body.invoiceId,
        amount: body.amount,
        date,
      });

      return NextResponse.json(result);
    }

    if (body.action === 'refund') {
      if (!body.bankAccountId) {
        return NextResponse.json({ error: 'bankAccountId is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (body.amount === undefined || body.amount === null) {
        return NextResponse.json({ error: 'amount is required', code: 'VALIDATION' }, { status: 400 });
      }

      const result = await refundCreditMemo(ctx, {
        creditMemoId: id,
        bankAccountId: body.bankAccountId,
        amount: body.amount,
        date: body.date ? new Date(body.date) : null,
        memo: body.memo ?? null,
      });

      return NextResponse.json(result);
    }

    if (body.action === 'unapply') {
      if (!body.applicationId) {
        return NextResponse.json({ error: 'applicationId is required', code: 'VALIDATION' }, { status: 400 });
      }
      const apps = await listCreditApplications(ctx, { creditMemoId: id });
      if (!apps.some((a) => a.id === body.applicationId)) {
        return NextResponse.json({ error: 'Credit application not found', code: 'NOT_FOUND' }, { status: 404 });
      }
      return NextResponse.json(await unapplyCreditApplication(ctx, body.applicationId));
    }

    return NextResponse.json(
      { error: `Unknown action '${body.action}'. Supported: apply, refund, unapply`, code: 'VALIDATION' },
      { status: 400 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = createCreditMemoSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await withVersionCheck(ctx, 'credit_memo', id, expectedVersion(req), (c) => updateCreditMemo(c, id, parsed.data)));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Alias of PUT — the shared api client exposes patch. */
export async function PATCH(req: NextRequest, rc: RouteContext) {
  return PUT(req, rc);
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const voided = await withVersionCheck(ctx, 'credit_memo', id, expectedVersion(req), (c) => voidCreditMemo(c, id));
    return NextResponse.json(voided);
  } catch (err) {
    return errorResponse(err);
  }
}
