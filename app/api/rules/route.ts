/**
 * GET  /api/rules  — list all active categorization rules for the company
 * POST /api/rules  — create a new categorization rule
 *
 * POST body:
 *   {
 *     name: string;
 *     matchField: "description" | "payee" | "amount";
 *     matchOperator: "contains" | "equals" | "starts_with";
 *     matchValue: string;
 *     setAccountId: string;   // UUID of the account to suggest
 *     setPayee?: string;      // optional payee override
 *     priority?: number;      // higher = evaluated first, default 0
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listRules, createRule } from '@/lib/services/rules';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

const VALID_MATCH_FIELDS = ['description', 'payee', 'amount'] as const;
const VALID_OPERATORS = ['contains', 'equals', 'starts_with'] as const;

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[rules/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET(_req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const rules = await listRules(ctx);
    return NextResponse.json(rules);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    // Validate required fields.
    if (!body.name || typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name is required', code: 'VALIDATION' }, { status: 400 });
    }
    if (!VALID_MATCH_FIELDS.includes(body.matchField)) {
      return NextResponse.json(
        { error: `matchField must be one of: ${VALID_MATCH_FIELDS.join(', ')}`, code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (!VALID_OPERATORS.includes(body.matchOperator)) {
      return NextResponse.json(
        { error: `matchOperator must be one of: ${VALID_OPERATORS.join(', ')}`, code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (!body.matchValue || typeof body.matchValue !== 'string') {
      return NextResponse.json(
        { error: 'matchValue is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (!body.setAccountId || typeof body.setAccountId !== 'string') {
      return NextResponse.json(
        { error: 'setAccountId is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const rule = await createRule(ctx, {
      name: body.name,
      matchField: body.matchField,
      matchOperator: body.matchOperator,
      matchValue: body.matchValue,
      setAccountId: body.setAccountId,
      setPayee: typeof body.setPayee === 'string' ? body.setPayee : null,
      priority: typeof body.priority === 'number' ? body.priority : 0,
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
