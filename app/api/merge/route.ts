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
 * Mapped to lists:delete (Merge Entries); every merge also needs the delete right of the list it
 * changes (Customer / Vendor Center, Edit Chart of Accounts, Item / Class / Other Lists, Employees).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { mergeAccounts, mergeCustomers, mergeVendors } from '@/lib/services/merge';
import { mergeClasses, mergeEmployees, mergeItems, mergeOtherNames } from '@/lib/services/lists/mergeLists';
import { requirePermission } from '@/lib/services/access';
import { ServiceError } from '@/lib/services/_base';
import { mergeMoreSchema } from '@/lib/validation/lists';
import { serviceErrorStatus } from '@/lib/routeErrors';

/** The list each merge type changes, whose delete right a merge needs as well as Merge Entries. */
const MERGE_OWNER_ACTIVITY = {
  customer: 'customers.center',
  vendor: 'vendors.center',
  account: 'accounting.chart_of_accounts',
  item: 'lists.items',
  class: 'lists.classes',
  employee: 'payroll.employees',
  other_name: 'lists.other_lists',
} as const;

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
    // Merge Entries is not enough on its own: a merge moves every transaction of the merged entry
    // and retires it, so the owning list's delete right is needed too (Edit Chart of Accounts for
    // accounts, the Customer / Vendor Center for names), as employees already were.
    requirePermission(ctx, MERGE_OWNER_ACTIVITY[parsed.data.type], 'delete');
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
