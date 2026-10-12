/**
 * Advanced Inventory reports (QB Desktop Enterprise parity):
 *   - Quantity on Hand by Site            quantityOnHandBySite
 *   - Inventory Stock Status by Site      stockStatusBySite
 *   - Inventory Reorder Report by Site    reorderBySite
 *   - Serial/Lot Numbers in Stock by Site serialLotInStock
 *   - Transactions by Serial/Lot Number   transactionsBySerialLot
 * plus `itemSiteDetail` (one item across sites/bins/serials/lots) and
 * `verifySiteInvariants`, the self-check behind "the books can never disagree":
 *   - Σ site quantities == quantity on hand for every inventory item
 *   - no negative site / bin / lot quantity, no serial in stock twice
 *   - serial-tracked items: serials in stock == quantity on hand; lot-tracked: Σ lots == on hand
 *   - inventory asset GL balance == inventory valuation
 *
 * Site values use the item's current unit cost (average cost, or the FIFO layers' effective
 * cost) — costing is item-level, so a site's share of value is quantity × that unit cost.
 * Committed (open sales orders) and on-PO quantities carry no site in this app; they are
 * attributed to the default site, where un-sited documents land.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  accounts,
  bills,
  creditMemos,
  inventoryBins,
  inventoryLots,
  inventoryMovements,
  inventorySites,
  inventoryTransfers,
  invoices,
  itemReceipts,
  itemSiteSettings,
  items,
  journalEntries,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  salesReceipts,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { inventoryValuation } from './inventory';
import { binQuantities, ensureDefaultSite, serialsInStock, siteQuantities } from './inventorySites';

type Dec = ReturnType<typeof Money.zero>;

async function loadSites(ctx: ServiceContext) {
  await ensureDefaultSite(ctx);
  const rows = await ctx.db
    .select()
    .from(inventorySites)
    .where(eq(inventorySites.companyId, ctx.companyId));
  return rows.sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1));
}

async function loadInventoryItems(ctx: ServiceContext, itemId?: string | null) {
  const conds = [eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')];
  if (itemId) conds.push(eq(items.id, itemId));
  return ctx.db.select().from(items).where(and(...conds)).orderBy(asc(items.name));
}

/** itemId → effective unit cost (average or FIFO layer cost), from the valuation report. */
async function unitCosts(ctx: ServiceContext): Promise<Map<string, Dec>> {
  const val = await inventoryValuation(ctx);
  return new Map(val.items.map((r) => [r.id, Money.of(r.averageCost)]));
}

async function binNames(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({ id: inventoryBins.id, name: inventoryBins.name })
    .from(inventoryBins)
    .where(eq(inventoryBins.companyId, ctx.companyId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// Quantity on Hand by Site
// ---------------------------------------------------------------------------

export interface QohBySiteRow {
  itemId: string;
  name: string;
  sku: string | null;
  trackingMode: string;
  unitCost: string;
  totalQuantity: string;
  totalValue: string;
  /** siteId → quantity (string, 4dp); sites with no stock are omitted. */
  bySite: Record<string, string>;
  /** Bin breakdown: [{ siteId, binId, binName, quantity }]. */
  bins: Array<{ siteId: string; binId: string; binName: string; quantity: string }>;
}

export async function quantityOnHandBySite(
  ctx: ServiceContext,
  opts?: { siteId?: string | null; itemId?: string | null; includeZero?: boolean },
) {
  const sites = await loadSites(ctx);
  const itemRows = (await loadInventoryItems(ctx, opts?.itemId)).filter((i) => i.isActive || !Money.of(i.quantityOnHand ?? '0').isZero());
  const qty = await siteQuantities(ctx, itemRows.map((i) => i.id));
  const bins = await binQuantities(ctx, { itemIds: itemRows.map((i) => i.id), siteId: opts?.siteId ?? null });
  const names = await binNames(ctx);
  const costs = await unitCosts(ctx);

  const siteTotals: Record<string, { quantity: Dec; value: Dec }> = {};
  for (const s of sites) siteTotals[s.id] = { quantity: Money.zero(), value: Money.zero() };
  let grandValue = Money.zero();

  const rows: QohBySiteRow[] = [];
  for (const it of itemRows) {
    const bySiteMap = qty.get(it.id) ?? new Map();
    const unitCost = costs.get(it.id) ?? Money.of(it.averageCost ?? '0');
    const bySite: Record<string, string> = {};
    let total = Money.zero();
    for (const [siteId, q] of bySiteMap) {
      if (opts?.siteId && siteId !== opts.siteId) continue;
      bySite[siteId] = q.toFixed(4);
      total = total.plus(q);
      const v = Money.round2(q.times(unitCost));
      if (siteTotals[siteId]) {
        siteTotals[siteId].quantity = siteTotals[siteId].quantity.plus(q);
        siteTotals[siteId].value = siteTotals[siteId].value.plus(v);
      }
    }
    if (total.isZero() && !opts?.includeZero) continue;
    const value = Money.round2(total.times(unitCost));
    grandValue = grandValue.plus(value);
    rows.push({
      itemId: it.id,
      name: it.name,
      sku: it.sku ?? null,
      trackingMode: it.trackingMode,
      unitCost: unitCost.toFixed(4),
      totalQuantity: total.toFixed(4),
      totalValue: toAmountString(value),
      bySite,
      bins: bins
        .filter((b) => b.itemId === it.id)
        .map((b) => ({ siteId: b.siteId, binId: b.binId, binName: names.get(b.binId) ?? '', quantity: b.quantity })),
    });
  }

  return {
    sites: sites
      .filter((s) => !opts?.siteId || s.id === opts.siteId)
      .map((s) => ({
        id: s.id,
        name: s.name,
        isDefault: s.isDefault,
        isActive: s.isActive,
        totalQuantity: siteTotals[s.id].quantity.toFixed(4),
        totalValue: toAmountString(siteTotals[s.id].value),
      })),
    rows,
    grandTotalValue: toAmountString(grandValue),
  };
}

// ---------------------------------------------------------------------------
// Stock Status by Site / Reorder by Site
// ---------------------------------------------------------------------------

export interface StockStatusBySiteRow {
  siteId: string;
  siteName: string;
  itemId: string;
  name: string;
  sku: string | null;
  onHand: string;
  /** Open sales-order quantity (attributed to the default site). */
  committed: string;
  available: string;
  /** Open PO quantity (attributed to the default site). */
  onPO: string;
  reorderPoint: string | null;
  maxQuantity: string | null;
  suggestedOrder: string;
  needsReorder: boolean;
}

export async function stockStatusBySite(
  ctx: ServiceContext,
  opts?: { siteId?: string | null; itemId?: string | null },
): Promise<{ rows: StockStatusBySiteRow[]; attentionCount: number }> {
  const sites = (await loadSites(ctx)).filter((s) => s.isActive);
  const defaultSite = sites.find((s) => s.isDefault) ?? (await ensureDefaultSite(ctx));
  const itemRows = (await loadInventoryItems(ctx, opts?.itemId)).filter((i) => i.isActive);
  const qty = await siteQuantities(ctx, itemRows.map((i) => i.id));

  const settings = await ctx.db
    .select()
    .from(itemSiteSettings)
    .where(eq(itemSiteSettings.companyId, ctx.companyId));
  const settingFor = new Map(settings.map((s) => [`${s.itemId}|${s.siteId}`, s]));

  const committedRows = await ctx.db
    .select({
      itemId: salesOrderLines.itemId,
      committed: sql<string>`COALESCE(SUM(GREATEST(${salesOrderLines.quantity} - ${salesOrderLines.quantityInvoiced}, 0)), 0)`,
    })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrderLines.salesOrderId, salesOrders.id))
    .where(and(eq(salesOrders.companyId, ctx.companyId), inArray(salesOrders.status, ['open', 'partial'])))
    .groupBy(salesOrderLines.itemId);
  const committedBy = new Map(committedRows.map((r) => [r.itemId, Money.of(r.committed)]));
  const onPoRows = await ctx.db
    .select({
      itemId: purchaseOrderLines.itemId,
      onPO: sql<string>`COALESCE(SUM(GREATEST(${purchaseOrderLines.quantity} - ${purchaseOrderLines.quantityBilled}, 0)), 0)`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .where(and(eq(purchaseOrders.companyId, ctx.companyId), inArray(purchaseOrders.status, ['open', 'partial'])))
    .groupBy(purchaseOrderLines.itemId);
  const onPoBy = new Map(onPoRows.map((r) => [r.itemId, Money.of(r.onPO)]));

  const rows: StockStatusBySiteRow[] = [];
  let attentionCount = 0;
  for (const site of sites) {
    if (opts?.siteId && site.id !== opts.siteId) continue;
    for (const it of itemRows) {
      const onHand = qty.get(it.id)?.get(site.id) ?? Money.zero();
      const setting = settingFor.get(`${it.id}|${site.id}`);
      // The default site falls back to the item-level reorder point when it has no site setting.
      const reorderRaw = setting?.reorderPoint ?? (site.id === defaultSite.id ? it.reorderPoint : null);
      const isDefault = site.id === defaultSite.id;
      const committed = isDefault ? (committedBy.get(it.id) ?? Money.zero()) : Money.zero();
      const onPO = isDefault ? (onPoBy.get(it.id) ?? Money.zero()) : Money.zero();
      if (onHand.isZero() && !reorderRaw && committed.isZero() && onPO.isZero()) continue;

      const available = onHand.minus(committed);
      let suggested = Money.zero();
      let needsReorder = false;
      if (reorderRaw != null) {
        const reorder = Money.of(reorderRaw);
        const projected = available.plus(onPO);
        if (projected.lessThanOrEqualTo(reorder)) {
          needsReorder = true;
          // Order up to max when set, else to 2x the reorder point (same heuristic as stockStatus).
          const target = setting?.maxQuantity ? Money.of(setting.maxQuantity) : reorder.times(2);
          const s = target.minus(projected);
          suggested = s.greaterThan(0) ? s : Money.zero();
        }
      }
      if (needsReorder || (available.lessThanOrEqualTo(0) && committed.greaterThan(0))) attentionCount += 1;
      rows.push({
        siteId: site.id,
        siteName: site.name,
        itemId: it.id,
        name: it.name,
        sku: it.sku ?? null,
        onHand: onHand.toFixed(4),
        committed: committed.toFixed(4),
        available: available.toFixed(4),
        onPO: onPO.toFixed(4),
        reorderPoint: reorderRaw != null ? Money.of(reorderRaw).toFixed(4) : null,
        maxQuantity: setting?.maxQuantity != null ? Money.of(setting.maxQuantity).toFixed(4) : null,
        suggestedOrder: suggested.toFixed(4),
        needsReorder,
      });
    }
  }
  return { rows, attentionCount };
}

export async function reorderBySite(ctx: ServiceContext, opts?: { siteId?: string | null }) {
  const { rows } = await stockStatusBySite(ctx, opts);
  return { rows: rows.filter((r) => r.needsReorder) };
}

// ---------------------------------------------------------------------------
// Serial / lot numbers in stock by site
// ---------------------------------------------------------------------------

export async function serialLotInStock(
  ctx: ServiceContext,
  opts?: { siteId?: string | null; itemId?: string | null },
) {
  const sites = await loadSites(ctx);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const names = await binNames(ctx);
  const itemRows = await loadInventoryItems(ctx, opts?.itemId);
  const itemById = new Map(itemRows.map((i) => [i.id, i]));
  const serialItemIds = itemRows.filter((i) => i.trackingMode === 'serial').map((i) => i.id);
  const lotItemIds = itemRows.filter((i) => i.trackingMode === 'lot').map((i) => i.id);

  const serialLocs = await serialsInStock(ctx, { itemIds: serialItemIds, siteId: opts?.siteId ?? null });
  // Date each serial was received (latest inbound movement still in effect).
  const received = serialLocs.length
    ? await ctx.db
        .select({
          itemId: inventoryMovements.itemId,
          serialNumber: inventoryMovements.serialNumber,
          date: sql<Date>`MAX(${inventoryMovements.date})`,
        })
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.companyId, ctx.companyId),
            inArray(inventoryMovements.itemId, [...new Set(serialLocs.map((s) => s.itemId))]),
            sql`${inventoryMovements.quantity} > 0`,
            isNull(inventoryMovements.reversedAt),
            isNull(inventoryMovements.reversalOfId),
          ),
        )
        .groupBy(inventoryMovements.itemId, inventoryMovements.serialNumber)
    : [];
  const receivedOn = new Map(received.map((r) => [`${r.itemId}|${r.serialNumber}`, r.date]));

  const serials = serialLocs
    .map((s) => ({
      itemId: s.itemId,
      itemName: itemById.get(s.itemId)?.name ?? '',
      serialNumber: s.serialNumber,
      siteId: s.siteId,
      siteName: siteName.get(s.siteId) ?? '',
      binId: s.binId,
      binName: s.binId ? (names.get(s.binId) ?? '') : null,
      receivedDate: receivedOn.get(`${s.itemId}|${s.serialNumber}`) ?? null,
    }))
    .sort((a, b) => a.itemName.localeCompare(b.itemName) || a.siteName.localeCompare(b.siteName) || a.serialNumber.localeCompare(b.serialNumber));

  let lots: Array<{
    itemId: string;
    itemName: string;
    lotNumber: string;
    siteId: string;
    siteName: string;
    binId: string | null;
    binName: string | null;
    quantity: string;
    expirationDate: Date | null;
  }> = [];
  if (lotItemIds.length > 0) {
    const conds = [
      eq(inventoryMovements.companyId, ctx.companyId),
      inArray(inventoryMovements.itemId, lotItemIds),
      sql`${inventoryMovements.lotNumber} IS NOT NULL`,
    ];
    if (opts?.siteId) conds.push(eq(inventoryMovements.siteId, opts.siteId));
    const rows = await ctx.db
      .select({
        itemId: inventoryMovements.itemId,
        lotNumber: inventoryMovements.lotNumber,
        siteId: inventoryMovements.siteId,
        binId: inventoryMovements.binId,
        qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
      })
      .from(inventoryMovements)
      .where(and(...conds))
      .groupBy(inventoryMovements.itemId, inventoryMovements.lotNumber, inventoryMovements.siteId, inventoryMovements.binId);
    const lotRows = await ctx.db
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.companyId, ctx.companyId), inArray(inventoryLots.itemId, lotItemIds)));
    const expiry = new Map(lotRows.map((l) => [`${l.itemId}|${l.lotNumber}`, l.expirationDate]));
    lots = rows
      .filter((r) => Money.of(r.qty).greaterThan(0))
      .map((r) => ({
        itemId: r.itemId,
        itemName: itemById.get(r.itemId)?.name ?? '',
        lotNumber: r.lotNumber!,
        siteId: r.siteId,
        siteName: siteName.get(r.siteId) ?? '',
        binId: r.binId ?? null,
        binName: r.binId ? (names.get(r.binId) ?? '') : null,
        quantity: Money.of(r.qty).toFixed(4),
        expirationDate: expiry.get(`${r.itemId}|${r.lotNumber}`) ?? null,
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName) || a.lotNumber.localeCompare(b.lotNumber));
  }

  return { serials, lots };
}

// ---------------------------------------------------------------------------
// Transactions by serial / lot number
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  bill: 'Bill',
  item_receipt: 'Item Receipt',
  adjustment: 'Inventory Adjustment',
  build: 'Assembly Build',
  unbuild: 'Assembly Unbuild',
  transfer: 'Transfer Inventory',
  site_rebalance: 'Default Site Change',
};

/** Human document numbers for movement sources (batched per source type). */
async function sourceNumbers(ctx: ServiceContext, refs: Array<{ type: string; id: string | null }>) {
  const out = new Map<string, string>();
  const idsOf = (t: string) => [...new Set(refs.filter((r) => r.type === t && r.id).map((r) => r.id!))];
  const put = (t: string, rows: Array<{ id: string; num: unknown }>) => {
    for (const r of rows) if (r.num != null && r.num !== '') out.set(`${t}:${r.id}`, String(r.num));
  };
  let ids = idsOf('invoice');
  if (ids.length) put('invoice', await ctx.db.select({ id: invoices.id, num: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))` }).from(invoices).where(inArray(invoices.id, ids)));
  ids = idsOf('sales_receipt');
  if (ids.length) put('sales_receipt', await ctx.db.select({ id: salesReceipts.id, num: sql<string>`COALESCE(NULLIF(${salesReceipts.refNumber}, ''), CAST(${salesReceipts.receiptNumber} AS TEXT))` }).from(salesReceipts).where(inArray(salesReceipts.id, ids)));
  ids = idsOf('credit_memo');
  if (ids.length) put('credit_memo', await ctx.db.select({ id: creditMemos.id, num: sql<string>`COALESCE(NULLIF(${creditMemos.refNumber}, ''), CAST(${creditMemos.memoNumber} AS TEXT))` }).from(creditMemos).where(inArray(creditMemos.id, ids)));
  ids = idsOf('bill');
  if (ids.length) put('bill', await ctx.db.select({ id: bills.id, num: bills.billNumber }).from(bills).where(inArray(bills.id, ids)));
  ids = idsOf('item_receipt');
  if (ids.length) put('item_receipt', await ctx.db.select({ id: itemReceipts.id, num: itemReceipts.reference }).from(itemReceipts).where(inArray(itemReceipts.id, ids)));
  ids = idsOf('transfer');
  if (ids.length) put('transfer', await ctx.db.select({ id: inventoryTransfers.id, num: inventoryTransfers.transferNumber }).from(inventoryTransfers).where(inArray(inventoryTransfers.id, ids)));
  ids = idsOf('adjustment');
  if (ids.length) put('adjustment', await ctx.db.select({ id: journalEntries.id, num: journalEntries.entryNumber }).from(journalEntries).where(inArray(journalEntries.id, ids)));
  return out;
}

export interface SerialLotTransactionRow {
  movementId: string;
  date: Date;
  itemId: string;
  itemName: string;
  serialNumber: string | null;
  lotNumber: string | null;
  siteId: string;
  siteName: string;
  binName: string | null;
  quantity: string;
  sourceType: string;
  sourceLabel: string;
  sourceId: string | null;
  sourceNumber: string | null;
  /** True when the source document was voided/edited (movement reversed). */
  reversed: boolean;
}

export async function transactionsBySerialLot(
  ctx: ServiceContext,
  opts: { serialNumber?: string | null; lotNumber?: string | null; itemId?: string | null; includeReversed?: boolean },
): Promise<{ rows: SerialLotTransactionRow[] }> {
  const conds = [eq(inventoryMovements.companyId, ctx.companyId), isNull(inventoryMovements.reversalOfId)];
  if (opts.serialNumber) conds.push(eq(inventoryMovements.serialNumber, opts.serialNumber.trim()));
  if (opts.lotNumber) conds.push(eq(inventoryMovements.lotNumber, opts.lotNumber.trim()));
  if (!opts.serialNumber && !opts.lotNumber) {
    conds.push(sql`(${inventoryMovements.serialNumber} IS NOT NULL OR ${inventoryMovements.lotNumber} IS NOT NULL)`);
  }
  if (opts.itemId) conds.push(eq(inventoryMovements.itemId, opts.itemId));
  if (!opts.includeReversed) conds.push(isNull(inventoryMovements.reversedAt));

  const rows = await ctx.db
    .select({ m: inventoryMovements, itemName: items.name, siteName: inventorySites.name, binName: inventoryBins.name })
    .from(inventoryMovements)
    .innerJoin(items, eq(inventoryMovements.itemId, items.id))
    .innerJoin(inventorySites, eq(inventoryMovements.siteId, inventorySites.id))
    .leftJoin(inventoryBins, eq(inventoryMovements.binId, inventoryBins.id))
    .where(and(...conds))
    .orderBy(asc(inventoryMovements.date), asc(inventoryMovements.createdAt))
    .limit(5000);

  const numbers = await sourceNumbers(ctx, rows.map((r) => ({ type: r.m.sourceType, id: r.m.sourceId })));
  return {
    rows: rows.map((r) => ({
      movementId: r.m.id,
      date: r.m.date,
      itemId: r.m.itemId,
      itemName: r.itemName,
      serialNumber: r.m.serialNumber,
      lotNumber: r.m.lotNumber,
      siteId: r.m.siteId,
      siteName: r.siteName,
      binName: r.binName ?? null,
      quantity: Money.of(r.m.quantity).toFixed(4),
      sourceType: r.m.sourceType,
      sourceLabel: SOURCE_LABELS[r.m.sourceType] ?? r.m.sourceType,
      sourceId: r.m.sourceId,
      sourceNumber: r.m.sourceId ? (numbers.get(`${r.m.sourceType}:${r.m.sourceId}`) ?? null) : null,
      reversed: Boolean(r.m.reversedAt),
    })),
  };
}

// ---------------------------------------------------------------------------
// One item across sites
// ---------------------------------------------------------------------------

export async function itemSiteDetail(ctx: ServiceContext, itemId: string) {
  const qoh = await quantityOnHandBySite(ctx, { itemId, includeZero: true });
  const tracked = await serialLotInStock(ctx, { itemId });
  return { ...qoh, serials: tracked.serials, lots: tracked.lots };
}

// ---------------------------------------------------------------------------
// Invariant self-check
// ---------------------------------------------------------------------------

export interface SiteInvariantCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function verifySiteInvariants(
  ctx: ServiceContext,
): Promise<{ checks: SiteInvariantCheck[]; allOk: boolean }> {
  const defaultSite = await ensureDefaultSite(ctx);
  const itemRows = await loadInventoryItems(ctx);
  const qty = await siteQuantities(ctx, itemRows.map((i) => i.id));
  const checks: SiteInvariantCheck[] = [];

  // 1. Σ sites == quantity on hand (and no negative site).
  const sumIssues: string[] = [];
  const negIssues: string[] = [];
  for (const it of itemRows) {
    const bySite = qty.get(it.id) ?? new Map();
    let total = Money.zero();
    for (const [siteId, q] of bySite) {
      total = total.plus(q);
      if (q.isNegative() && !(siteId === defaultSite.id && Money.of(it.quantityOnHand ?? '0').isNegative())) {
        negIssues.push(`${it.name} (${q.toFixed(4)})`);
      }
    }
    if (!total.equals(Money.of(it.quantityOnHand ?? '0'))) {
      sumIssues.push(`${it.name}: sites ${total.toFixed(4)} vs on hand ${Money.of(it.quantityOnHand ?? '0').toFixed(4)}`);
    }
  }
  checks.push({
    name: 'Site quantities add up to quantity on hand',
    ok: sumIssues.length === 0,
    detail: sumIssues.length === 0 ? `All ${itemRows.length} inventory items reconcile.` : sumIssues.slice(0, 10).join('; '),
  });
  checks.push({
    name: 'No negative site quantities',
    ok: negIssues.length === 0,
    detail: negIssues.length === 0 ? 'No site holds a negative quantity.' : negIssues.slice(0, 10).join('; '),
  });

  // 2. Bins and lots never negative; serials never in stock twice.
  const binRows = await ctx.db
    .select({
      itemId: inventoryMovements.itemId,
      binId: inventoryMovements.binId,
      qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
    })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.companyId, ctx.companyId), sql`${inventoryMovements.binId} IS NOT NULL`))
    .groupBy(inventoryMovements.itemId, inventoryMovements.binId);
  const badBins = binRows.filter((r) => Money.of(r.qty).isNegative()).length;
  const serialRows = await ctx.db
    .select({
      itemId: inventoryMovements.itemId,
      serialNumber: inventoryMovements.serialNumber,
      qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)`,
    })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.companyId, ctx.companyId), sql`${inventoryMovements.serialNumber} IS NOT NULL`))
    .groupBy(inventoryMovements.itemId, inventoryMovements.serialNumber);
  const badSerials = serialRows.filter((r) => {
    const q = Money.of(r.qty);
    return q.isNegative() || q.greaterThan(1);
  });
  checks.push({
    name: 'Bins and serial numbers are consistent',
    ok: badBins === 0 && badSerials.length === 0,
    detail:
      badBins === 0 && badSerials.length === 0
        ? 'No negative bin quantity; every serial number is in stock at most once.'
        : `${badBins} negative bin balance(s); ${badSerials.length} serial number(s) out of range: ${badSerials
            .slice(0, 5)
            .map((s) => s.serialNumber)
            .join(', ')}`,
  });

  // 3. Serial / lot coverage of on-hand quantity.
  const coverage: string[] = [];
  const serialCount = new Map<string, Dec>();
  for (const r of serialRows) {
    const q = Money.of(r.qty);
    if (q.greaterThan(0)) serialCount.set(r.itemId, (serialCount.get(r.itemId) ?? Money.zero()).plus(q));
  }
  const lotRows = await ctx.db
    .select({ itemId: inventoryMovements.itemId, qty: sql<string>`COALESCE(SUM(${inventoryMovements.quantity}), 0)` })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.companyId, ctx.companyId), sql`${inventoryMovements.lotNumber} IS NOT NULL`))
    .groupBy(inventoryMovements.itemId);
  const lotQty = new Map(lotRows.map((r) => [r.itemId, Money.of(r.qty)]));
  for (const it of itemRows) {
    const onHand = Money.of(it.quantityOnHand ?? '0');
    if (it.trackingMode === 'serial') {
      const n = serialCount.get(it.id) ?? Money.zero();
      if (!n.equals(onHand)) coverage.push(`${it.name}: ${n.toFixed(0)} serial(s) vs ${onHand.toFixed(4)} on hand`);
    } else if (it.trackingMode === 'lot') {
      const n = lotQty.get(it.id) ?? Money.zero();
      if (!n.equals(onHand)) coverage.push(`${it.name}: lots ${n.toFixed(4)} vs ${onHand.toFixed(4)} on hand`);
    }
  }
  checks.push({
    name: 'Serial/lot numbers cover quantity on hand',
    ok: coverage.length === 0,
    detail: coverage.length === 0 ? 'Every tracked unit on hand has its serial/lot number.' : coverage.slice(0, 10).join('; '),
  });

  // 4. Inventory asset GL == inventory valuation.
  const valuation = await inventoryValuation(ctx);
  const accountIds = new Set(itemRows.map((i) => i.assetAccountId).filter(Boolean) as string[]);
  const [acct1300] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1300')));
  if (acct1300) accountIds.add(acct1300.id);
  let gl = Money.zero();
  if (accountIds.size > 0) {
    const accts = await ctx.db
      .select({ balance: accounts.balance })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, [...accountIds])));
    for (const a of accts) gl = gl.plus(Money.of(a.balance));
  }
  const diff = gl.minus(Money.of(valuation.grandTotal));
  checks.push({
    name: 'Inventory asset GL equals inventory valuation',
    ok: Money.round2(diff).isZero(),
    detail: `GL ${toAmountString(gl)} vs valuation ${valuation.grandTotal}${Money.round2(diff).isZero() ? '' : ` (difference ${toAmountString(diff)})`}.`,
  });

  return { checks, allOk: checks.every((c) => c.ok) };
}
