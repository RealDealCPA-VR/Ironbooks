/**
 * POST /api/merge
 *
 * Merge duplicate customers, vendors, GL accounts, items, classes, employees or other names.
 *
 * Request body:
 *   {
 *     type:   'customer' | 'vendor' | 'account' | 'item' | 'class' | 'employee' | 'other_name',
 *     fromId: string,   // duplicate — will be deactivated
 *     toId:   string,   // master — survives (accounts / items: must be the same type)
 *   }
 *
 * Response 200: { reassigned: {...}, deactivatedId: string }
 *               (accounts also return newBalance — the survivor's recomputed balance)
 * Errors: 400 (validation), 403, 404 (not found), 409 (conflict), 500.
 *
 * Mapped to lists:delete; merging employees also needs payroll:delete and merging accounts
 * keeps its historical mapping (lists).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { mergeAccounts, mergeCustomers, mergeVendors } from '@/lib/services/merge';
import { mergeClasses, mergeEmployees, mergeItems, mergeOtherNames } from '@/lib/services/lists/mergeLists';
import { requirePermission } from '@/lib/services/access';
import { ServiceError } from '@/lib/services/_base';
import { mergeMoreSchema } from '@/lib/validation/lists';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[merge/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => null)) ?? {}; // a JSON null reads as {} → 400 below

    const { type, fromId, toId } = body as { type?: string; fromId?: string; toId?: string };
    if (!type || !fromId || !toId) {
      return NextResponse.json(
        { error: 'type, fromId, and toId are required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const parsed = mergeMoreSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "type must be 'customer', 'vendor', 'account', 'item', 'class', 'employee' or 'other_name', and both ids must be valid",
          code: 'VALIDATION',
        },
        { status: 400 },
      );
    }

    const input = { fromId: parsed.data.fromId, toId: parsed.data.toId };
    let result;
    switch (parsed.data.type) {
      case 'customer':
        result = await mergeCustomers(ctx, input);
        break;
      case 'vendor':
        result = await mergeVendors(ctx, input);
        break;
      case 'account':
        result = await mergeAccounts(ctx, input);
        break;
      case 'item':
        result = await mergeItems(ctx, input);
        break;
      case 'class':
        result = await mergeClasses(ctx, input);
        break;
      case 'employee':
        requirePermission(ctx, 'payroll', 'delete');
        result = await mergeEmployees(ctx, input);
        break;
      case 'other_name':
        result = await mergeOtherNames(ctx, input);
        break;
    }

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
