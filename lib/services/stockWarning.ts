/**
 * Negative-inventory warning (QB Preferences > Items & Inventory "Warn if not enough inventory to
 * sell"), enforced server-side so the warning carries fixes (lib/errorFixes.ts):
 * "Sell anyway", "Sell only the N on hand", "Adjust quantity on hand".
 *
 * Opt-in per request: the sales forms send `checkStock: true`; the "Sell anyway" fix retries with
 * `checkStock: false`. Internal callers (imports, recurring, conversions) never set it, so they keep
 * QB's behaviour of letting stock go negative silently. A soft warning: the API answers it as
 * code NEGATIVE_STOCK (409) via lib/salesRouteErrors.ts.
 */
import Decimal from 'decimal.js';
import { and, eq, inArray } from 'drizzle-orm';
import { items } from '@/lib/db/schema';
import { negativeStockFixes, negativeStockMessage, type StockShortfall } from '@/lib/errorFixes';
import { type ServiceContext, ServiceError } from './_base';
import { getPreferences } from './company';

export const NEGATIVE_STOCK = 'NEGATIVE_STOCK';

export interface StockLineInput {
  itemId?: string | null;
  quantity?: string | number | null;
}

const STOCKED = new Set(['inventory', 'assembly']);

function qty(v: string | number | null | undefined): Decimal {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  try {
    return new Decimal(typeof v === 'string' ? v.trim() : v);
  } catch {
    return new Decimal(0);
  }
}

/**
 * Items this document sells beyond what is available. `alreadyOnDocument` = the lines the
 * document already relieved (an edit gives those back before re-selling).
 */
export async function findStockShortfalls(
  ctx: ServiceContext,
  lines: readonly StockLineInput[],
  alreadyOnDocument: readonly StockLineInput[] = [],
): Promise<StockShortfall[]> {
  const need = new Map<string, { qty: Decimal; idx: number[] }>();
  lines.forEach((l, i) => {
    if (!l.itemId) return;
    const q = qty(l.quantity);
    if (!q.greaterThan(0)) return;
    const cur = need.get(l.itemId) ?? { qty: new Decimal(0), idx: [] };
    cur.qty = cur.qty.plus(q);
    cur.idx.push(i);
    need.set(l.itemId, cur);
  });
  if (need.size === 0) return [];
  const rows = await ctx.db
    .select({ id: items.id, name: items.name, type: items.type, onHand: items.quantityOnHand })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, [...need.keys()])));
  const back = new Map<string, Decimal>();
  for (const l of alreadyOnDocument) {
    if (l.itemId) back.set(l.itemId, (back.get(l.itemId) ?? new Decimal(0)).plus(qty(l.quantity)));
  }
  const out: StockShortfall[] = [];
  for (const r of rows) {
    if (!STOCKED.has(r.type)) continue;
    const n = need.get(r.id)!;
    const have = qty(r.onHand).plus(back.get(r.id) ?? 0);
    if (n.qty.greaterThan(have)) {
      out.push({
        itemId: r.id,
        name: r.name,
        need: n.qty.toString(),
        have: Decimal.max(have, 0).toString(),
        lineIndexes: n.idx,
      });
    }
  }
  return out;
}

/** Throw the NEGATIVE_STOCK soft warning (with fixes) when the preference is on and stock is short. */
export async function assertStockAvailable(
  ctx: ServiceContext,
  lines: readonly StockLineInput[],
  alreadyOnDocument: readonly StockLineInput[] = [],
): Promise<void> {
  if (!(await getPreferences(ctx)).negativeStockWarning) return;
  const shortfalls = await findStockShortfalls(ctx, lines, alreadyOnDocument);
  if (shortfalls.length === 0) return;
  throw new ServiceError(
    'VALIDATION',
    negativeStockMessage(shortfalls),
    { warning: NEGATIVE_STOCK, shortfalls },
    negativeStockFixes(shortfalls, { continuePatch: [{ op: 'set', path: 'checkStock', value: false }] }),
  );
}
