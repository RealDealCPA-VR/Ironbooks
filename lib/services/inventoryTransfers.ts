/**
 * Transfer Inventory between sites (QB Desktop Enterprise "Transfer Inventory").
 *
 * A transfer moves quantity (with its bins, serial numbers and lots) from one site to another.
 * It has NO GL impact: costing in this app is item-level (FIFO layers / average cost), so the
 * item's total quantity on hand and inventory value are unchanged — only the site-tagged
 * movement ledger records the move (sourceType 'transfer'). Voiding reverses the movements and
 * is refused once the destination no longer holds the transferred stock.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  inventorySites,
  inventoryTransferLines,
  inventoryTransfers,
  items,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { assertPeriodOpen, recordClosingDateException } from './fiscalPeriods';
import { type MovementRequest, getSite, normalizeSerials, recordMovements, reverseSourceMovements } from './inventorySites';

export interface InventoryTransferLineInput {
  itemId: string;
  quantity: string | number;
  fromBinId?: string | null;
  toBinId?: string | null;
  serialNumbers?: string[] | null;
  lotNumber?: string | null;
}

export interface CreateInventoryTransferInput {
  date: Date;
  fromSiteId: string;
  toSiteId: string;
  memo?: string | null;
  lines: InventoryTransferLineInput[];
}

async function nextTransferNumber(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${inventoryTransfers.transferNumber}), 0)` })
    .from(inventoryTransfers)
    .where(eq(inventoryTransfers.companyId, ctx.companyId));
  return Number(row?.max ?? 0) + 1;
}

export async function createInventoryTransfer(ctx: ServiceContext, input: CreateInventoryTransferInput) {
  if (!input.lines || input.lines.length === 0) throw validation('A transfer needs at least one line.');
  if (input.fromSiteId === input.toSiteId) throw validation('Choose two different sites to transfer between.');

  return inTransaction(ctx, async (tx) => {
    // No GL, so posting.ts never checks the period — a transfer is still a dated transaction
    // the closing date locks (QB parity).
    const periodCheck = await assertPeriodOpen(tx, input.date);
    const from = await getSite(tx, input.fromSiteId);
    const to = await getSite(tx, input.toSiteId);
    if (!from.isActive || !to.isActive) throw validation('Transfers require active sites.');

    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const itemRows = await tx.db
      .select({ id: items.id, name: items.name, type: items.type })
      .from(items)
      .where(and(eq(items.companyId, tx.companyId), inArray(items.id, itemIds)));
    const itemById = new Map(itemRows.map((r) => [r.id, r]));

    const lines = input.lines.map((l, i) => {
      const item = itemById.get(l.itemId);
      if (!item) throw notFound(`Item ${l.itemId}`);
      if (item.type !== 'inventory') throw validation(`Line ${i + 1}: "${item.name}" is not an inventory item.`);
      let qty;
      try {
        // Quantities are stored at 4dp — round first so a sub-precision quantity cannot slip
        // through as a zero-quantity line.
        qty = Money.of(l.quantity).toDecimalPlaces(4);
      } catch {
        throw validation(`Line ${i + 1}: quantity must be a number.`);
      }
      if (!qty.isFinite() || !qty.greaterThan(0)) throw validation(`Line ${i + 1}: quantity must be greater than zero.`);
      return { ...l, qty, serials: normalizeSerials(l.serialNumbers), lot: l.lotNumber?.trim() || null, lineOrder: i };
    });

    const [header] = await tx.db
      .insert(inventoryTransfers)
      .values({
        companyId: tx.companyId,
        transferNumber: await nextTransferNumber(tx),
        date: input.date,
        fromSiteId: from.id,
        toSiteId: to.id,
        status: 'posted',
        memo: input.memo ?? null,
      })
      .returning();

    const insertedLines = await tx.db
      .insert(inventoryTransferLines)
      .values(
        lines.map((l) => ({
          transferId: header.id,
          itemId: l.itemId,
          quantity: l.qty.toFixed(4),
          fromBinId: l.fromBinId ?? null,
          toBinId: l.toBinId ?? null,
          serialNumbers: l.serials.length ? l.serials : null,
          lotNumber: l.lot,
          lineOrder: l.lineOrder,
        })),
      )
      .returning();

    // Inbound rows first, then outbound rows (so an outbound from the default site sees its
    // post-transfer remainder when choosing bins); validated together at the end.
    const memo = `Transfer #${header.transferNumber}: ${from.name} → ${to.name}`;
    const base = { date: input.date, sourceType: 'transfer', sourceId: header.id, memo };
    const requests: MovementRequest[] = [
      ...lines.map((l) => ({
        ...base,
        itemId: l.itemId,
        siteId: to.id,
        binId: l.toBinId ?? null,
        quantity: l.qty,
        serialNumbers: l.serials,
        lotNumber: l.lot,
        sourceLine: l.lineOrder,
      })),
      ...lines.map((l) => ({
        ...base,
        itemId: l.itemId,
        siteId: from.id,
        binId: l.fromBinId ?? null,
        quantity: l.qty.negated(),
        serialNumbers: l.serials,
        lotNumber: l.lot,
        sourceLine: l.lineOrder,
      })),
    ];
    await recordMovements(tx, requests);
    // Entered with the closing-date password: on record for the Closing Date Exception report
    // (posting.ts does this for documents with an entry; a transfer has none).
    await recordClosingDateException(tx, periodCheck, {
      entryId: header.id,
      operation: 'post',
      transactionDate: input.date,
      description: memo,
      sourceRef: `inventory_transfer:${header.id}`,
    });

    await writeAudit(tx, {
      action: 'create',
      entityType: 'inventory_transfer',
      entityId: header.id,
      newValues: {
        transferNumber: header.transferNumber,
        fromSiteId: from.id,
        toSiteId: to.id,
        lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.qty.toFixed(4), serials: l.serials, lot: l.lot })),
      },
    });

    return { ...header, lines: insertedLines };
  });
}

export async function listInventoryTransfers(ctx: ServiceContext, opts?: { siteId?: string; status?: string }) {
  const conds = [eq(inventoryTransfers.companyId, ctx.companyId)];
  if (opts?.status) conds.push(eq(inventoryTransfers.status, opts.status));
  const rows = await ctx.db
    .select()
    .from(inventoryTransfers)
    .where(and(...conds))
    .orderBy(desc(inventoryTransfers.date), desc(inventoryTransfers.transferNumber));
  const filtered = opts?.siteId
    ? rows.filter((r) => r.fromSiteId === opts.siteId || r.toSiteId === opts.siteId)
    : rows;
  if (filtered.length === 0) return [];

  const sites = await ctx.db
    .select({ id: inventorySites.id, name: inventorySites.name })
    .from(inventorySites)
    .where(eq(inventorySites.companyId, ctx.companyId));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const counts = await ctx.db
    .select({
      transferId: inventoryTransferLines.transferId,
      lineCount: sql<number>`count(*)`,
      totalQty: sql<string>`COALESCE(SUM(${inventoryTransferLines.quantity}), 0)`,
    })
    .from(inventoryTransferLines)
    .where(inArray(inventoryTransferLines.transferId, filtered.map((r) => r.id)))
    .groupBy(inventoryTransferLines.transferId);
  const countBy = new Map(counts.map((c) => [c.transferId, c]));
  return filtered.map((r) => ({
    ...r,
    fromSiteName: siteName.get(r.fromSiteId) ?? '',
    toSiteName: siteName.get(r.toSiteId) ?? '',
    lineCount: Number(countBy.get(r.id)?.lineCount ?? 0),
    totalQuantity: Money.of(countBy.get(r.id)?.totalQty ?? '0').toFixed(4),
  }));
}

export async function getInventoryTransfer(ctx: ServiceContext, id: string) {
  const [header] = await ctx.db
    .select()
    .from(inventoryTransfers)
    .where(and(eq(inventoryTransfers.companyId, ctx.companyId), eq(inventoryTransfers.id, id)));
  if (!header) throw notFound('Inventory transfer');
  const lines = await ctx.db
    .select({ line: inventoryTransferLines, itemName: items.name, sku: items.sku })
    .from(inventoryTransferLines)
    .innerJoin(items, eq(inventoryTransferLines.itemId, items.id))
    .where(eq(inventoryTransferLines.transferId, id))
    .orderBy(asc(inventoryTransferLines.lineOrder));
  return { ...header, lines: lines.map((l) => ({ ...l.line, itemName: l.itemName, sku: l.sku })) };
}

export async function voidInventoryTransfer(ctx: ServiceContext, id: string) {
  return inTransaction(ctx, async (tx) => {
    const transfer = await getInventoryTransfer(tx, id);
    if (transfer.status === 'void') return transfer;
    const periodCheck = await assertPeriodOpen(tx, transfer.date, { movable: false });
    try {
      await reverseSourceMovements(tx, 'transfer', id);
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'CONFLICT') {
        throw new ServiceError('CONFLICT', `Cannot void transfer #${transfer.transferNumber}: ${err.message}`);
      }
      throw err;
    }
    const [updated] = await tx.db
      .update(inventoryTransfers)
      .set({ status: 'void', voidedAt: new Date() })
      .where(eq(inventoryTransfers.id, id))
      .returning();
    await recordClosingDateException(tx, periodCheck, {
      entryId: id,
      operation: 'void',
      transactionDate: transfer.date,
      description: `Transfer #${transfer.transferNumber} voided`,
      sourceRef: `inventory_transfer:${id}`,
    });
    await writeAudit(tx, {
      action: 'void',
      entityType: 'inventory_transfer',
      entityId: id,
      oldValues: { status: transfer.status },
      newValues: { status: 'void' },
    });
    return updated;
  });
}
