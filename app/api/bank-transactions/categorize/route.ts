/**
 * POST /api/bank-transactions/categorize
 *
 * Categorize a single staged bank transaction into the GL (QB "Add to register").
 *
 * Request body:
 *   {
 *     bankTransactionId: string;   // UUID of the bank_transactions row
 *     accountId: string;           // offsetting GL account (income, expense, etc.)
 *     payee?: string;              // optional payee override
 *     memo?: string;               // optional memo / reference
 *     exchangeRate?: string;       // foreign-currency account: home units per 1 unit (default: list rate)
 *     classId?: string;            // bankrules: class for the offset line(s)
 *     splits?: [{ accountId, classId?, percent }]  // bankrules: split by percentage (sums to 100)
 *   }
 *
 * Response 200: { transaction, entry, ruleOffer }
 *   ruleOffer (bankrules): "Always categorize SHELL OIL as Fuel?" when this was the 2nd+ time the
 *   same pattern went to the same account and no rule covers it yet; otherwise null.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { categorize } from '@/lib/services/bankCategorize';
import { offerForTransaction } from '@/lib/services/bankRules';
import { splitSchema } from '@/lib/bankRules/schemas';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errResponse(err: ServiceError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code, details: err.details ?? null },
    { status: serviceErrorStatus(err.code) },
  );
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    const { bankTransactionId, accountId, payee, memo, exchangeRate, classId, splits } = body ?? {};

    if (!bankTransactionId) {
      return NextResponse.json({ error: 'bankTransactionId is required.' }, { status: 400 });
    }
    const parsedSplits = Array.isArray(splits) && splits.length > 0 ? splitSchema.array().max(20).safeParse(splits) : null;
    if (parsedSplits && !parsedSplits.success) {
      return NextResponse.json({ error: 'splits must be a list of { accountId, classId?, percent }.', code: 'VALIDATION' }, { status: 400 });
    }
    if (!accountId && !parsedSplits) {
      return NextResponse.json({ error: 'accountId is required.' }, { status: 400 });
    }

    const result = await categorize(ctx, {
      bankTransactionId,
      accountId,
      payee: payee ?? null,
      memo: memo ?? null,
      exchangeRate: exchangeRate ?? null,
      classId: typeof classId === 'string' && classId ? classId : null,
      splits: parsedSplits?.success ? parsedSplits.data : null,
      source: 'user',
    });

    // bankrules: offer to turn a repeated choice into a rule (best effort — never fails the post).
    const ruleOffer = await offerForTransaction(ctx, bankTransactionId).catch(() => null);
    return NextResponse.json({ ...result, ruleOffer });
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[POST /api/bank-transactions/categorize]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
