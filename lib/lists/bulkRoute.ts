/**
 * Shared body handling for the Add/Edit Multiple routes (app/api/{customers,vendors,items}/bulk).
 * POST { rows, dryRun? } → validates every row; saves all-or-nothing. Rows with an id edit
 * existing records, which needs 'modify' on top of the route's mapped 'create'.
 */
import { NextResponse } from 'next/server';
import type { ServiceContext } from '@/lib/services/_base';
import { requirePermission } from '@/lib/services/access';
import { bulkSave } from '@/lib/services/lists/bulk';
import { bulkSchema } from '@/lib/validation/lists';
import { zodErrorBody } from '@/lib/validation/helpers';
import type { Area } from '@/lib/permissions/model';
import type { BulkList } from './bulk';

export async function handleBulkPost(ctx: ServiceContext, list: BulkList, area: Area, body: unknown): Promise<NextResponse> {
  const parsed = bulkSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
  if (parsed.data.rows.some((r) => typeof r.id === 'string' && r.id.trim() !== '')) {
    requirePermission(ctx, area, 'modify');
  }
  // An opening quantity on hand posts to the ledger (Dr Inventory Asset / Cr Opening Balance
  // Equity), so — exactly like the New Item form (POST /api/items) — it needs inventory rights on
  // top of the list rights this route is mapped to.
  const filled = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
  if (
    list === 'items' &&
    parsed.data.rows.some((r) => filled(r.openingQuantity) || filled(r.openingValue) || filled(r.openingAsOf))
  ) {
    requirePermission(ctx, 'inventory', 'create');
  }
  const result = await bulkSave(ctx, list, parsed.data.rows, { dryRun: parsed.data.dryRun });
  // Row problems are a normal outcome of checking a grid: 200 with per-row errors (saved=false).
  return NextResponse.json(result);
}
