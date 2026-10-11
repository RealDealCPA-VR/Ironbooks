/**
 * Assemblies / Bill of Materials service.
 *
 * An "assembly" is an inventory item whose stock is built from component items.
 * QuickBooks Desktop calls these "Assembly Items".
 *
 * --- GL treatment for buildAssembly / unbuildAssembly ---
 *
 * Both sides of the transaction live in account 1300 (Inventory Asset):
 *   - Component items DECREASE in value  (their qty * averageCost moves out)
 *   - Assembly item   INCREASES in value (receives that same total cost)
 *
 * Net impact on account 1300 = $0.  A Dr 1300 / Cr 1300 journal entry would be
 * a zero-net wash that adds noise to the GL without changing any balance.
 * Therefore we skip GL posting entirely for assembly builds and instead update
 * item-level quantities and averageCost directly — consistent with how
 * QuickBooks handles assembly builds when the BOM only moves inventory between
 * items on the same asset account.
 *
 * If your chart of accounts uses SEPARATE asset accounts per item, you would
 * need per-account postings; this service intentionally keeps it simple and
 * mirrors the common single-account approach.
 *
 * The zero-net wash only holds if total item-level value is conserved, so:
 *   - unbuildAssembly distributes the assembly's removed value back to the
 *     components (instead of restoring them at their possibly-drifted current
 *     averageCost) — see unbuildAssembly's doc comment.
 *   - FIFO-tracked items (any item with inventoryLayers rows) are rejected by
 *     build/unbuild, since this module's averageCost math never touches
 *     layers; route those items through fifo.ts instead.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { assemblyComponents, items, pendingBuilds } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertNotFifoTracked } from './inventory';
import { type InventoryLineDetail, type MovementRequest, recordMovements } from './inventorySites';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BomComponent {
  componentItemId: string;
  quantity: string | number;
}

export interface BomRow {
  id: string;
  componentItemId: string;
  componentName: string;
  componentSku: string | null;
  quantity: string;
}

export interface BuildInput extends InventoryLineDetail {
  assemblyItemId: string;
  /** Number of finished assemblies to build (must be > 0). */
  quantity: string | number;
  /**
   * Advanced Inventory: the site the build happens at (components are drawn from and the
   * finished assemblies land in this site; defaults to the default site). `binId`,
   * `serialNumbers`, `lotNumber`, `lotExpiration` describe the FINISHED assemblies;
   * per-component bins / serials / lots go in `components`.
   */
  components?: Array<{
    componentItemId: string;
    binId?: string | null;
    serialNumbers?: string[] | null;
    lotNumber?: string | null;
  }> | null;
  /** Date stamped on the site movements (defaults to now). */
  date?: Date | null;
}

/**
 * Site-tagged movements for a build (direction 1) or unbuild (direction -1): components move
 * out (in for unbuild) and the assembly moves in (out for unbuild) at the build's site.
 */
function buildMovements(
  input: BuildInput,
  bom: Array<{ componentItemId: string; quantity: string }>,
  qty: ReturnType<typeof Money.zero>,
  direction: 1 | -1,
  sourceType: 'build' | 'unbuild',
  sourceId: string,
): MovementRequest[] {
  const date = input.date ?? new Date();
  const memo = `Assembly ${sourceType}`;
  const detailFor = (id: string) => input.components?.find((c) => c.componentItemId === id);
  return [
    ...bom.map((b, i) => {
      const d = detailFor(b.componentItemId);
      return {
        itemId: b.componentItemId,
        siteId: input.siteId ?? null,
        binId: d?.binId ?? null,
        quantity: qty.times(Money.of(b.quantity)).times(-direction),
        serialNumbers: d?.serialNumbers ?? null,
        lotNumber: d?.lotNumber ?? null,
        date,
        sourceType,
        sourceId,
        sourceLine: i + 1,
        memo,
      };
    }),
    {
      itemId: input.assemblyItemId,
      siteId: input.siteId ?? null,
      binId: input.binId ?? null,
      quantity: qty.times(direction),
      serialNumbers: input.serialNumbers ?? null,
      lotNumber: input.lotNumber ?? null,
      lotExpiration: input.lotExpiration ?? null,
      date,
      sourceType,
      sourceId,
      sourceLine: 0,
      memo,
    },
  ];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadItem(ctx: ServiceContext, itemId: string) {
  const [row] = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.id, itemId)));
  if (!row) throw notFound('Item');
  return row;
}

// ---------------------------------------------------------------------------
// setBom — replace the entire BOM for an assembly item
// ---------------------------------------------------------------------------

/**
 * Replace the bill of materials for an assembly item.
 *
 * Rules:
 *   - assemblyItemId must belong to ctx.companyId.
 *   - Every componentItemId must belong to ctx.companyId.
 *   - A component cannot be the assembly itself (self-reference).
 *   - Duplicate componentItemIds in the input are rejected.
 *   - All quantities must be > 0.
 */
export async function setBom(
  ctx: ServiceContext,
  assemblyItemId: string,
  components: BomComponent[],
): Promise<BomRow[]> {
  // Validate the assembly item belongs to this company
  await loadItem(ctx, assemblyItemId);

  if (!components || components.length === 0) {
    // Empty BOM — clear it
    return inTransaction(ctx, async (tx) => {
      await tx.db
        .delete(assemblyComponents)
        .where(
          and(
            eq(assemblyComponents.companyId, tx.companyId),
            eq(assemblyComponents.assemblyItemId, assemblyItemId),
          ),
        );
      await writeAudit(tx, {
        action: 'update',
        entityType: 'assembly_bom',
        entityId: assemblyItemId,
        newValues: { components: [] },
      });
      return [];
    });
  }

  // Validate no self-reference
  for (const c of components) {
    if (c.componentItemId === assemblyItemId) {
      throw validation('An assembly item cannot be a component of itself.');
    }
  }

  // Validate no duplicate component IDs
  const componentIds = components.map((c) => c.componentItemId);
  const unique = new Set(componentIds);
  if (unique.size !== componentIds.length) {
    throw validation('Duplicate component items in BOM are not allowed.');
  }

  // Validate all quantities > 0
  for (const c of components) {
    const qty = Money.of(c.quantity);
    if (!qty.greaterThan(0)) {
      throw validation(`Component quantity must be greater than zero (got ${c.quantity}).`);
    }
  }

  // Validate all component items belong to this company
  const componentRows = await ctx.db
    .select({ id: items.id, name: items.name, sku: items.sku })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, componentIds)));

  const componentMap = new Map(componentRows.map((r) => [r.id, r]));
  for (const c of components) {
    if (!componentMap.has(c.componentItemId)) {
      throw notFound(`Component item ${c.componentItemId}`);
    }
  }

  // Reject circular references (direct or indirect): if the assembly is
  // reachable from any of the new components through existing BOMs, saving
  // this BOM would make the assembly a component of itself.
  let frontier = [...componentIds];
  const visited = new Set<string>(componentIds);
  while (frontier.length > 0) {
    const edges = await ctx.db
      .select({ componentItemId: assemblyComponents.componentItemId })
      .from(assemblyComponents)
      .where(
        and(
          eq(assemblyComponents.companyId, ctx.companyId),
          inArray(assemblyComponents.assemblyItemId, frontier),
        ),
      );

    const next: string[] = [];
    for (const edge of edges) {
      if (edge.componentItemId === assemblyItemId) {
        throw validation(
          'This BOM would create a circular assembly reference: the assembly is (directly or indirectly) a component of itself.',
        );
      }
      if (!visited.has(edge.componentItemId)) {
        visited.add(edge.componentItemId);
        next.push(edge.componentItemId);
      }
    }
    frontier = next;
  }

  return inTransaction(ctx, async (tx) => {
    // Delete old BOM rows for this assembly
    await tx.db
      .delete(assemblyComponents)
      .where(
        and(
          eq(assemblyComponents.companyId, tx.companyId),
          eq(assemblyComponents.assemblyItemId, assemblyItemId),
        ),
      );

    // Insert new BOM rows
    const inserted = await tx.db
      .insert(assemblyComponents)
      .values(
        components.map((c) => ({
          companyId: tx.companyId,
          assemblyItemId,
          componentItemId: c.componentItemId,
          quantity: Money.of(c.quantity).toFixed(4),
        })),
      )
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'assembly_bom',
      entityId: assemblyItemId,
      newValues: { components: components.map((c) => ({ ...c, quantity: Money.of(c.quantity).toFixed(4) })) },
    });

    return inserted.map((row) => {
      const comp = componentMap.get(row.componentItemId)!;
      return {
        id: row.id,
        componentItemId: row.componentItemId,
        componentName: comp.name,
        componentSku: comp.sku ?? null,
        quantity: row.quantity,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// getBom — fetch the current BOM
// ---------------------------------------------------------------------------

export async function getBom(ctx: ServiceContext, assemblyItemId: string): Promise<BomRow[]> {
  // Ensure assembly belongs to company
  await loadItem(ctx, assemblyItemId);

  const rows = await ctx.db
    .select({
      id: assemblyComponents.id,
      componentItemId: assemblyComponents.componentItemId,
      quantity: assemblyComponents.quantity,
      componentName: items.name,
      componentSku: items.sku,
    })
    .from(assemblyComponents)
    .innerJoin(items, eq(assemblyComponents.componentItemId, items.id))
    .where(
      and(
        eq(assemblyComponents.companyId, ctx.companyId),
        eq(assemblyComponents.assemblyItemId, assemblyItemId),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    componentItemId: r.componentItemId,
    componentName: r.componentName,
    componentSku: r.componentSku ?? null,
    quantity: r.quantity,
  }));
}

// ---------------------------------------------------------------------------
// buildAssembly — consume components, produce finished assemblies
// ---------------------------------------------------------------------------

/**
 * Build `quantity` units of the assembly.
 *
 * For each BOM component:
 *   - Requires quantityOnHand >= quantity * componentQty
 *   - Reduces component quantityOnHand by quantity * componentQty
 *   - Adds component cost (componentQty * averageCost) to the running total
 *
 * Updates assembly item:
 *   - Increases quantityOnHand by `quantity`
 *   - Sets averageCost = totalComponentCost / quantity  (weighted into existing stock)
 *
 * GL: No journal entry is posted. Both sides are account 1300 (Inventory Asset),
 * so the net GL impact is $0.  Moving the cost between items is captured in the
 * item-level averageCost and quantityOnHand fields, which drive the inventory
 * valuation report. An audit log entry documents the build for traceability.
 */
export async function buildAssembly(
  ctx: ServiceContext,
  input: BuildInput,
): Promise<{
  assemblyItemId: string;
  quantityBuilt: string;
  totalCost: string;
  newAssemblyQty: string;
  newAssemblyAvgCost: string;
  buildId: string;
}> {
  const buildQty = Money.of(input.quantity);
  if (!buildQty.greaterThan(0)) {
    throw validation('Build quantity must be greater than zero.');
  }

  const assembly = await loadItem(ctx, input.assemblyItemId);
  const bom = await getBom(ctx, input.assemblyItemId);

  if (bom.length === 0) {
    throw validation('Assembly has no bill of materials. Add components before building.');
  }

  // Builds are an average-cost operation: components are consumed at
  // averageCost and layers are never touched. Refuse FIFO-tracked items
  // (assembly and components alike), matching adjustInventory/recordCOGS.
  await assertNotFifoTracked(ctx, input.assemblyItemId);
  for (const bomLine of bom) {
    await assertNotFifoTracked(ctx, bomLine.componentItemId);
  }

  // Load all component items with a single query
  const componentIds = bom.map((b) => b.componentItemId);
  const componentRows = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, componentIds)));
  const componentMap = new Map(componentRows.map((r) => [r.id, r]));

  // Validate sufficient stock for all components
  let totalCost = Money.zero();
  for (const bomLine of bom) {
    const comp = componentMap.get(bomLine.componentItemId);
    if (!comp) throw notFound(`Component item ${bomLine.componentItemId}`);

    const required = buildQty.times(Money.of(bomLine.quantity));
    const onHand = Money.of(comp.quantityOnHand ?? '0');

    if (onHand.lessThan(required)) {
      throw validation(
        `Insufficient stock for component "${comp.name}": need ${required.toFixed(4)}, have ${onHand.toFixed(4)}.`,
      );
    }

    // Accumulate cost: componentQtyPerUnit * buildQty * averageCost
    const compCost = required.times(Money.of(comp.averageCost ?? '0'));
    totalCost = totalCost.plus(compCost);
  }

  return inTransaction(ctx, async (tx) => {
    // Reduce each component's quantityOnHand
    for (const bomLine of bom) {
      const comp = componentMap.get(bomLine.componentItemId)!;
      const consumed = buildQty.times(Money.of(bomLine.quantity));
      const newQty = Money.of(comp.quantityOnHand ?? '0').minus(consumed);

      await tx.db
        .update(items)
        .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
        .where(eq(items.id, comp.id));

      await writeAudit(tx, {
        action: 'update',
        entityType: 'item',
        entityId: comp.id,
        oldValues: { quantityOnHand: comp.quantityOnHand },
        newValues: {
          quantityOnHand: newQty.toFixed(4),
          reason: `assembly_build:${input.assemblyItemId}`,
        },
      });
    }

    // Increase assembly quantityOnHand and recalculate weighted averageCost
    const existingQty = Money.of(assembly.quantityOnHand ?? '0');
    const existingAvgCost = Money.of(assembly.averageCost ?? '0');
    const existingValue = existingQty.times(existingAvgCost);
    const newAssemblyQty = existingQty.plus(buildQty);
    const newAssemblyAvgCost = newAssemblyQty.isZero()
      ? Money.zero()
      : existingValue.plus(totalCost).dividedBy(newAssemblyQty);

    await tx.db
      .update(items)
      .set({
        quantityOnHand: newAssemblyQty.toFixed(4),
        averageCost: newAssemblyAvgCost.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(items.id, input.assemblyItemId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: input.assemblyItemId,
      oldValues: {
        quantityOnHand: assembly.quantityOnHand,
        averageCost: assembly.averageCost,
      },
      newValues: {
        quantityOnHand: newAssemblyQty.toFixed(4),
        averageCost: newAssemblyAvgCost.toFixed(4),
        quantityBuilt: buildQty.toFixed(4),
        totalComponentCost: toAmountString(totalCost),
      },
    });

    // Advanced Inventory: components leave, finished goods arrive, at the build's site.
    const buildId = randomUUID();
    await recordMovements(tx, buildMovements(input, bom, buildQty, 1, 'build', buildId));

    return {
      assemblyItemId: input.assemblyItemId,
      quantityBuilt: buildQty.toFixed(4),
      totalCost: toAmountString(totalCost),
      newAssemblyQty: newAssemblyQty.toFixed(4),
      newAssemblyAvgCost: newAssemblyAvgCost.toFixed(4),
      buildId,
    };
  });
}

// ---------------------------------------------------------------------------
// unbuildAssembly — reverse a build: restore component qty, reduce assembly qty
// ---------------------------------------------------------------------------

/**
 * Unbuild `quantity` finished assemblies back into their components.
 *
 * The value removed from the assembly (unbuildQty * assembly.averageCost) is
 * distributed back to the components proportionally to their current-cost
 * share, and each component's averageCost is recalculated as a weighted
 * average of its existing stock and the returned units at that distributed
 * unit cost. Total item-level inventory value is therefore conserved exactly,
 * which is what keeps the no-GL-posting design sound: account 1300 is
 * unchanged and item-level valuation still ties to it even when component
 * costs have drifted since the build.
 */
export async function unbuildAssembly(
  ctx: ServiceContext,
  input: BuildInput,
): Promise<{
  assemblyItemId: string;
  quantityUnbuilt: string;
  newAssemblyQty: string;
}> {
  const unbuildQty = Money.of(input.quantity);
  if (!unbuildQty.greaterThan(0)) {
    throw validation('Unbuild quantity must be greater than zero.');
  }

  const assembly = await loadItem(ctx, input.assemblyItemId);
  const currentAssemblyQty = Money.of(assembly.quantityOnHand ?? '0');

  if (unbuildQty.greaterThan(currentAssemblyQty)) {
    throw validation(
      `Cannot unbuild ${unbuildQty.toFixed(4)} units; only ${currentAssemblyQty.toFixed(4)} on hand.`,
    );
  }

  const bom = await getBom(ctx, input.assemblyItemId);
  if (bom.length === 0) {
    throw validation('Assembly has no bill of materials.');
  }

  // Same average-cost guard as buildAssembly: FIFO-tracked items must go
  // through the FIFO endpoints, not item-level averageCost math.
  await assertNotFifoTracked(ctx, input.assemblyItemId);
  for (const bomLine of bom) {
    await assertNotFifoTracked(ctx, bomLine.componentItemId);
  }

  const componentIds = bom.map((b) => b.componentItemId);
  const componentRows = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, componentIds)));
  const componentMap = new Map(componentRows.map((r) => [r.id, r]));

  // Value being removed from the assembly item. The returned components must
  // absorb exactly this value (not their current averageCost) so that total
  // inventory value is conserved without a GL posting.
  const removedValue = unbuildQty.times(Money.of(assembly.averageCost ?? '0'));

  // Distribute removedValue across components proportionally to their
  // current-cost share; if every component carries a $0 averageCost,
  // fall back to a quantity-based split.
  const returnLines = bom.map((bomLine) => {
    const comp = componentMap.get(bomLine.componentItemId);
    if (!comp) throw notFound(`Component item ${bomLine.componentItemId}`);
    const returned = unbuildQty.times(Money.of(bomLine.quantity));
    const currentValue = returned.times(Money.of(comp.averageCost ?? '0'));
    return { comp, returned, currentValue };
  });

  const totalCurrentValue = returnLines.reduce(
    (sum, l) => sum.plus(l.currentValue),
    Money.zero(),
  );
  const totalReturnedQty = returnLines.reduce(
    (sum, l) => sum.plus(l.returned),
    Money.zero(),
  );

  return inTransaction(ctx, async (tx) => {
    // Restore each component's quantityOnHand, weighting the returned value
    // share into the component's averageCost.
    for (const line of returnLines) {
      const { comp, returned } = line;

      const share = totalCurrentValue.greaterThan(0)
        ? line.currentValue.dividedBy(totalCurrentValue)
        : totalReturnedQty.greaterThan(0)
          ? returned.dividedBy(totalReturnedQty)
          : Money.zero();
      const valueReturned = removedValue.times(share);

      const oldQty = Money.of(comp.quantityOnHand ?? '0');
      const oldValue = oldQty.times(Money.of(comp.averageCost ?? '0'));
      const newQty = oldQty.plus(returned);
      const newAvgCost = newQty.isZero()
        ? Money.zero()
        : oldValue.plus(valueReturned).dividedBy(newQty);

      await tx.db
        .update(items)
        .set({
          quantityOnHand: newQty.toFixed(4),
          averageCost: newAvgCost.toFixed(4),
          updatedAt: new Date(),
        })
        .where(eq(items.id, comp.id));

      await writeAudit(tx, {
        action: 'update',
        entityType: 'item',
        entityId: comp.id,
        oldValues: {
          quantityOnHand: comp.quantityOnHand,
          averageCost: comp.averageCost,
        },
        newValues: {
          quantityOnHand: newQty.toFixed(4),
          averageCost: newAvgCost.toFixed(4),
          valueReturned: toAmountString(Money.round2(valueReturned)),
          reason: `assembly_unbuild:${input.assemblyItemId}`,
        },
      });
    }

    // Reduce assembly quantityOnHand (averageCost stays the same)
    const newAssemblyQty = currentAssemblyQty.minus(unbuildQty);

    await tx.db
      .update(items)
      .set({
        quantityOnHand: newAssemblyQty.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(items.id, input.assemblyItemId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: input.assemblyItemId,
      oldValues: { quantityOnHand: assembly.quantityOnHand },
      newValues: {
        quantityOnHand: newAssemblyQty.toFixed(4),
        quantityUnbuilt: unbuildQty.toFixed(4),
      },
    });

    // Advanced Inventory: finished goods leave, components return, at the site.
    await recordMovements(tx, buildMovements(input, bom, unbuildQty, -1, 'unbuild', randomUUID()));

    return {
      assemblyItemId: input.assemblyItemId,
      quantityUnbuilt: unbuildQty.toFixed(4),
      newAssemblyQty: newAssemblyQty.toFixed(4),
    };
  });
}

// ---------------------------------------------------------------------------
// Pending builds (QB "Pending Builds")
// ---------------------------------------------------------------------------
//
// A pending build is a queued buildAssembly: it records the intent to build N
// units of an assembly without moving any stock. Finalizing runs the normal
// buildAssembly (with all its guards); it is blocked with per-component
// shortage detail while components are insufficient. Pending builds can also
// be cancelled. Statuses: 'pending' -> 'built' | 'cancelled'.

export interface ComponentAvailabilityRow {
  componentItemId: string;
  componentName: string;
  componentSku: string | null;
  /** Quantity required for the full pending build (bomQty * buildQty). */
  required: string;
  onHand: string;
  /** max(required - onHand, 0). */
  shortage: string;
}

/**
 * Component availability for building `quantity` units of an assembly:
 * required vs on-hand per BOM component, plus an overall canBuild flag.
 */
export async function componentAvailability(
  ctx: ServiceContext,
  assemblyItemId: string,
  quantity: string | number,
): Promise<{ components: ComponentAvailabilityRow[]; canBuild: boolean }> {
  const buildQty = Money.of(quantity);
  const bom = await getBom(ctx, assemblyItemId);
  if (bom.length === 0) return { components: [], canBuild: false };

  const componentIds = bom.map((b) => b.componentItemId);
  const componentRows = await ctx.db
    .select({ id: items.id, quantityOnHand: items.quantityOnHand })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, componentIds)));
  const onHandById = new Map(componentRows.map((r) => [r.id, Money.of(r.quantityOnHand ?? '0')]));

  let canBuild = true;
  const components: ComponentAvailabilityRow[] = bom.map((line) => {
    const required = buildQty.times(Money.of(line.quantity));
    const onHand = onHandById.get(line.componentItemId) ?? Money.zero();
    const shortage = required.greaterThan(onHand) ? required.minus(onHand) : Money.zero();
    if (shortage.greaterThan(0)) canBuild = false;
    return {
      componentItemId: line.componentItemId,
      componentName: line.componentName,
      componentSku: line.componentSku,
      required: required.toFixed(4),
      onHand: onHand.toFixed(4),
      shortage: shortage.toFixed(4),
    };
  });

  return { components, canBuild };
}

export interface PendingBuildRow {
  id: string;
  assemblyItemId: string;
  assemblyName: string;
  assemblySku: string | null;
  quantity: string;
  date: Date;
  memo: string | null;
  status: string;
  createdAt: Date;
  /** Live availability — only computed for status 'pending'. */
  components: ComponentAvailabilityRow[];
  canBuild: boolean;
  shortageCount: number;
}

export interface CreatePendingBuildInput {
  assemblyItemId: string;
  quantity: string | number;
  date: Date;
  memo?: string | null;
}

/**
 * Queue a pending build. Validates the assembly belongs to the company, the
 * quantity is positive, and a BOM exists; returns the live component
 * availability so the UI can flag shortages immediately.
 */
export async function createPendingBuild(
  ctx: ServiceContext,
  input: CreatePendingBuildInput,
): Promise<PendingBuildRow> {
  const qty = Money.of(input.quantity);
  if (!qty.greaterThan(0)) throw validation('Pending build quantity must be greater than zero.');

  const assembly = await loadItem(ctx, input.assemblyItemId);
  const bom = await getBom(ctx, input.assemblyItemId);
  if (bom.length === 0) {
    throw validation('Assembly has no bill of materials. Add components before queueing a build.');
  }

  const availability = await componentAvailability(ctx, input.assemblyItemId, qty.toFixed(4));

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(pendingBuilds)
      .values({
        companyId: tx.companyId,
        assemblyItemId: input.assemblyItemId,
        quantity: qty.toFixed(4),
        date: input.date,
        memo: input.memo ?? null,
        status: 'pending',
      })
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'pending_build',
      entityId: row.id,
      newValues: {
        assemblyItemId: input.assemblyItemId,
        quantity: qty.toFixed(4),
        date: input.date.toISOString(),
        memo: input.memo ?? null,
      },
    });

    return {
      id: row.id,
      assemblyItemId: row.assemblyItemId,
      assemblyName: assembly.name,
      assemblySku: assembly.sku ?? null,
      quantity: row.quantity,
      date: row.date,
      memo: row.memo,
      status: row.status,
      createdAt: row.createdAt,
      components: availability.components,
      canBuild: availability.canBuild,
      shortageCount: availability.components.filter((c) => Money.of(c.shortage).greaterThan(0)).length,
    };
  });
}

/**
 * List pending builds (newest first). Live shortage detail is computed for
 * rows still in 'pending'; built/cancelled rows return empty availability.
 * Pass `status` to filter ('pending' | 'built' | 'cancelled').
 */
export async function listPendingBuilds(
  ctx: ServiceContext,
  status?: string | null,
): Promise<PendingBuildRow[]> {
  const conditions = [eq(pendingBuilds.companyId, ctx.companyId)];
  if (status) conditions.push(eq(pendingBuilds.status, status));

  const rows = await ctx.db
    .select({
      id: pendingBuilds.id,
      assemblyItemId: pendingBuilds.assemblyItemId,
      quantity: pendingBuilds.quantity,
      date: pendingBuilds.date,
      memo: pendingBuilds.memo,
      status: pendingBuilds.status,
      createdAt: pendingBuilds.createdAt,
      assemblyName: items.name,
      assemblySku: items.sku,
    })
    .from(pendingBuilds)
    .innerJoin(items, eq(pendingBuilds.assemblyItemId, items.id))
    .where(and(...conditions))
    .orderBy(desc(pendingBuilds.createdAt));

  const result: PendingBuildRow[] = [];
  for (const r of rows) {
    let components: ComponentAvailabilityRow[] = [];
    let canBuild = false;
    if (r.status === 'pending') {
      const availability = await componentAvailability(ctx, r.assemblyItemId, r.quantity);
      components = availability.components;
      canBuild = availability.canBuild;
    }
    result.push({
      id: r.id,
      assemblyItemId: r.assemblyItemId,
      assemblyName: r.assemblyName,
      assemblySku: r.assemblySku ?? null,
      quantity: r.quantity,
      date: r.date,
      memo: r.memo,
      status: r.status,
      createdAt: r.createdAt,
      components,
      canBuild,
      shortageCount: components.filter((c) => Money.of(c.shortage).greaterThan(0)).length,
    });
  }
  return result;
}

async function loadPendingBuild(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(pendingBuilds)
    .where(and(eq(pendingBuilds.companyId, ctx.companyId), eq(pendingBuilds.id, id)));
  if (!row) throw notFound('Pending build');
  return row;
}

/**
 * Finalize a pending build: runs buildAssembly for the queued quantity and
 * marks the row 'built'. Blocked with per-component shortage detail (VALIDATION,
 * details.shortages) when components are insufficient.
 */
export async function finalizePendingBuild(
  ctx: ServiceContext,
  id: string,
  opts?: Omit<BuildInput, 'assemblyItemId' | 'quantity'>,
): Promise<{
  pendingBuildId: string;
  status: string;
  build: Awaited<ReturnType<typeof buildAssembly>>;
}> {
  const row = await loadPendingBuild(ctx, id);
  if (row.status !== 'pending') {
    throw validation(`Only pending builds can be finalized (this build is "${row.status}").`);
  }

  const availability = await componentAvailability(ctx, row.assemblyItemId, row.quantity);
  if (!availability.canBuild) {
    const shortages = availability.components.filter((c) => Money.of(c.shortage).greaterThan(0));
    throw validation(
      `Cannot finalize: insufficient component stock for ${shortages.length} component(s).`,
      { shortages },
    );
  }

  return inTransaction(ctx, async (tx) => {
    // buildAssembly re-validates stock inside the same transaction (and rejects
    // FIFO-tracked items); any failure rolls the status update back too.
    const build = await buildAssembly(tx, {
      ...opts,
      assemblyItemId: row.assemblyItemId,
      quantity: row.quantity,
      date: opts?.date ?? row.date,
    });

    await tx.db
      .update(pendingBuilds)
      .set({ status: 'built' })
      .where(eq(pendingBuilds.id, id));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'pending_build',
      entityId: id,
      oldValues: { status: 'pending' },
      newValues: { status: 'built', totalCost: build.totalCost },
    });

    return { pendingBuildId: id, status: 'built', build };
  });
}

/** Cancel a pending build (status 'pending' -> 'cancelled'). No stock moves. */
export async function cancelPendingBuild(
  ctx: ServiceContext,
  id: string,
): Promise<{ pendingBuildId: string; status: string }> {
  const row = await loadPendingBuild(ctx, id);
  if (row.status !== 'pending') {
    throw validation(`Only pending builds can be cancelled (this build is "${row.status}").`);
  }

  return inTransaction(ctx, async (tx) => {
    await tx.db
      .update(pendingBuilds)
      .set({ status: 'cancelled' })
      .where(eq(pendingBuilds.id, id));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'pending_build',
      entityId: id,
      oldValues: { status: 'pending' },
      newValues: { status: 'cancelled' },
    });

    return { pendingBuildId: id, status: 'cancelled' };
  });
}
