/**
 * POST /api/bank-transactions/bulk
 *
 * Bulk operations on staged bank transactions.
 *
 * Request body:
 *   {
 *     bankAccountId: string;
 *     action: 'applyRules' | 'categorizeSuggested';
 *   }
 *
 * Response 200:
 *   { count: number }   — number of transactions updated / categorized
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { bulkApplyRules, categorizeSuggested } from '@/lib/services/bankCategorize';
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

    const { bankAccountId, action } = body ?? {};

    if (!bankAccountId) {
      return NextResponse.json({ error: 'bankAccountId is required.' }, { status: 400 });
    }
    if (action !== 'applyRules' && action !== 'categorizeSuggested') {
      return NextResponse.json(
        { error: "action must be 'applyRules' or 'categorizeSuggested'." },
        { status: 400 },
      );
    }

    let count: number;
    if (action === 'applyRules') {
      count = await bulkApplyRules(ctx, bankAccountId);
    } else {
      count = await categorizeSuggested(ctx, bankAccountId);
    }

    return NextResponse.json({ count });
  } catch (err) {
    if (err instanceof ServiceError) return errResponse(err);
    console.error('[POST /api/bank-transactions/bulk]', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
