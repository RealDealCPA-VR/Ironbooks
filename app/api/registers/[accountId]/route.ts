/**
 * GET /api/registers/:accountId
 *
 * QB-style per-account register: chronological posted lines with a true running
 * balance, opening/closing balances, optional date-range + search filters, and
 * limit/offset paging.
 *
 * Query params:
 *   from    ISO date string — inclusive start filter (optional).
 *   to      ISO date string — inclusive end filter (optional).
 *   search  substring match on description / reference / memo (optional).
 *   limit   page size (optional; omit for all rows).
 *   offset  offset into the filtered ascending row set (optional).
 *
 * POST /api/registers/:accountId
 *
 * Save a transaction typed into the register's blank row (date, number, payee, account, memo,
 * one amount column). It is saved as the document QB would make (check, deposit, transfer,
 * credit card charge / credit or journal entry — lib/registerEntryPlan.ts) through that
 * document's own service. A duplicate check number is refused (409) unless
 * allowDuplicateNumber is true.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { accountRegister } from '@/lib/services/journal';
import { withAccountCurrency } from '@/lib/services/fxLedger';
import { enterRegisterTransaction } from '@/lib/services/registerEntry';
import { queryDate, zodErrorBody } from '@/lib/validation/helpers';
import { registerEntrySchema } from '@/lib/validation/registers';
import { serviceErrorStatus } from '@/lib/routeErrors';

type Params = { params: Promise<{ accountId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { accountId } = await params;
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;

    const from = queryDate(sp, 'from');
    const to = queryDate(sp, 'to');
    const search = sp.get('search') ?? undefined;
    const limitRaw = sp.get('limit');
    const offsetRaw = sp.get('offset');
    const limit = limitRaw != null && limitRaw !== '' ? Number(limitRaw) : undefined;
    const offset = offsetRaw != null && offsetRaw !== '' ? Number(offsetRaw) : undefined;

    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return NextResponse.json({ error: 'limit must be a positive number.' }, { status: 400 });
    }
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
      return NextResponse.json({ error: 'offset must be a non-negative number.' }, { status: 400 });
    }

    const opts = { from, to, search, limit, offset };
    // p1 fx: a foreign-currency bank / card register also carries account-currency columns.
    const register = await withAccountCurrency(ctx, await accountRegister(ctx, accountId, opts), opts);
    return NextResponse.json({ register });
  } catch (err) {
    return mapError(err);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { accountId } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = registerEntrySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });

    const { allowDuplicateNumber, ...input } = parsed.data;
    const entry = await enterRegisterTransaction(ctx, accountId, { ...input, checkDuplicateNumber: !allowDuplicateNumber });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    return mapError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared error mapper (code → HTTP status).
// ---------------------------------------------------------------------------
function mapError(err: unknown): NextResponse {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[registers/[accountId]] Unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
