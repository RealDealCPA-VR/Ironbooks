/**
 * Merge for items, classes, employees and other names (QB: rename a list entry to an existing
 * name → "merge"). Customers, vendors and accounts live in lib/services/merge.ts.
 *
 * Every merge runs in ONE transaction: re-point every foreign key to the duplicate onto the
 * survivor (catalog-driven, lib/services/lists/references.ts, so tables added later are covered),
 * resolve rows that would collide on a unique key, carry notes / to-dos over, deactivate the
 * duplicate and write the audit trail. No journal line amount or account changes — the trial
 * balance and balance sheet are untouched by construction:
 *  - items: same type, same tracking mode, same inventory asset account and compatible costing
 *    are required, so the inventory value simply moves from one item record to the other;
 *  - classes: only the class tag on lines moves (allowed by the ledger guard, which protects
 *    entry / account / amounts);
 *  - employees: refused when both have paychecks (it would merge two people's W-2 wages).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  accounts,
  assemblyComponents,
  billingRateLevelItems,
  classes,
  customerPrices,
  employees,
  expenses,
  inventoryLayers,
  inventoryLots,
  items,
  itemSiteSettings,
  journalEntryLines,
  otherNames,
  paychecks,
  priceLevelItems,
  recurringTemplates,
} from '@/lib/db/schema';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';
import { Money, toAmountString } from '@/lib/money';
import { allowLedgerRewrite, postJournalEntry } from '../posting';
import { moveNotesAndTodos } from './notes';
import { repointForeignKeys } from './references';
import { assertListDeleteAllowed } from '../accountantCopy/guard';

export interface ListMergeResult {
  reassigned: Record<string, number>;
  deactivatedId: string;
}

async function rewriteTemplates(tx: ServiceContext, fromId: string, toId: string): Promise<number> {
  let n = 0;
  const templates = await tx.db
    .select({ id: recurringTemplates.id, template: recurringTemplates.template })
    .from(recurringTemplates)
    .where(eq(recurringTemplates.companyId, tx.companyId));
  for (const t of templates) {
    const json = JSON.stringify(t.template);
    if (json.includes(fromId)) {
      await tx.db
        .update(recurringTemplates)
        .set({ template: JSON.parse(json.split(fromId).join(toId)) })
        .where(eq(recurringTemplates.id, t.id));
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

async function inventoryAccountId(ctx: ServiceContext, item: { assetAccountId: string | null }): Promise<string | null> {
  if (item.assetAccountId) return item.assetAccountId;
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1300')));
  return row?.id ?? null;
}

async function hasLayers(ctx: ServiceContext, itemId: string): Promise<boolean> {
  const [r] = await ctx.db
    .select({ id: inventoryLayers.id })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)))
    .limit(1);
  return !!r;
}

export async function mergeItems(ctx: ServiceContext, { fromId, toId }: { fromId: string; toId: string }): Promise<ListMergeResult> {
  await assertListDeleteAllowed(ctx, 'merge', 'items'); // Accountant's Copy (I1)
  if (fromId === toId) throw validation('Cannot merge an item with itself.');
  const load = async (id: string) => {
    const [row] = await ctx.db.select().from(items).where(and(eq(items.id, id), eq(items.companyId, ctx.companyId)));
    if (!row) throw notFound(`Item ${id}`);
    return row;
  };
  const from = await load(fromId);
  const to = await load(toId);
  if (from.type !== to.type) {
    throw validation(`Items must be the same type to merge ("${from.name}" is ${from.type}, "${to.name}" is ${to.type}).`);
  }
  if (from.trackingMode !== to.trackingMode) {
    throw validation('Both items must use the same serial/lot tracking to merge.');
  }
  if (from.uomSetId && to.uomSetId && from.uomSetId !== to.uomSetId) {
    throw validation('These items count stock in different units of measure, so they cannot be merged.');
  }
  const fromQty = new Decimal(from.quantityOnHand ?? 0);
  const toQty = new Decimal(to.quantityOnHand ?? 0);
  let averageCosted = false; // both items valued at quantity x average cost (no FIFO layers)
  if (from.type === 'inventory') {
    const [a, b] = [await inventoryAccountId(ctx, from), await inventoryAccountId(ctx, to)];
    if (a !== b) {
      throw validation(
        'These items keep their value in different inventory asset accounts. Point both at the same account first, so the merge does not move value between accounts.',
      );
    }
    const [fFifo, tFifo] = [await hasLayers(ctx, fromId), await hasLayers(ctx, toId)];
    averageCosted = !fFifo && !tFifo;
    if (fFifo !== tFifo) {
      const avgSideQty = fFifo ? toQty : fromQty;
      if (!avgSideQty.isZero()) {
        throw validation(
          'One item is costed FIFO and the other at average cost, and the average-cost item has stock on hand. Bring its quantity to zero (or receive it through FIFO) before merging.',
        );
      }
    }
  }
  const selfBom = await ctx.db
    .select({ id: assemblyComponents.id })
    .from(assemblyComponents)
    .where(
      and(
        eq(assemblyComponents.companyId, ctx.companyId),
        sql`(${assemblyComponents.assemblyItemId} = ${toId} AND ${assemblyComponents.componentItemId} = ${fromId})
          OR (${assemblyComponents.assemblyItemId} = ${fromId} AND ${assemblyComponents.componentItemId} = ${toId})`,
      ),
    )
    .limit(1);
  if (selfBom.length) throw validation('One of these items is a component of the other, so they cannot be merged.');

  return inTransaction(ctx, async (tx) => {
    const reassigned: Record<string, number> = {};
    // Rows that would collide on a unique key: the survivor's own setting wins.
    const toLevels = (await tx.db.select({ v: priceLevelItems.priceLevelId }).from(priceLevelItems).where(eq(priceLevelItems.itemId, toId))).map((r) => r.v);
    if (toLevels.length) {
      await tx.db.delete(priceLevelItems).where(and(eq(priceLevelItems.itemId, fromId), inArray(priceLevelItems.priceLevelId, toLevels)));
    }
    const toRateLevels = (await tx.db.select({ v: billingRateLevelItems.levelId }).from(billingRateLevelItems).where(eq(billingRateLevelItems.itemId, toId))).map((r) => r.v);
    if (toRateLevels.length) {
      await tx.db.delete(billingRateLevelItems).where(and(eq(billingRateLevelItems.itemId, fromId), inArray(billingRateLevelItems.levelId, toRateLevels)));
    }
    const toCustPrices = (await tx.db.select({ v: customerPrices.customerId }).from(customerPrices).where(eq(customerPrices.itemId, toId))).map((r) => r.v);
    if (toCustPrices.length) {
      await tx.db.delete(customerPrices).where(and(eq(customerPrices.itemId, fromId), inArray(customerPrices.customerId, toCustPrices)));
    }
    const toSites = (await tx.db.select({ v: itemSiteSettings.siteId }).from(itemSiteSettings).where(eq(itemSiteSettings.itemId, toId))).map((r) => r.v);
    if (toSites.length) {
      await tx.db.delete(itemSiteSettings).where(and(eq(itemSiteSettings.itemId, fromId), inArray(itemSiteSettings.siteId, toSites)));
    }
    const toLots = (await tx.db.select({ v: inventoryLots.lotNumber }).from(inventoryLots).where(eq(inventoryLots.itemId, toId))).map((r) => r.v);
    if (toLots.length) {
      await tx.db.delete(inventoryLots).where(and(eq(inventoryLots.itemId, fromId), inArray(inventoryLots.lotNumber, toLots)));
    }
    // A bill of materials listing both items: fold the duplicate's quantity into the survivor's line.
    const fromBom = await tx.db.select().from(assemblyComponents).where(and(eq(assemblyComponents.companyId, tx.companyId), eq(assemblyComponents.componentItemId, fromId)));
    for (const line of fromBom) {
      const [twin] = await tx.db
        .select()
        .from(assemblyComponents)
        .where(and(eq(assemblyComponents.assemblyItemId, line.assemblyItemId), eq(assemblyComponents.componentItemId, toId)));
      if (twin) {
        await tx.db
          .update(assemblyComponents)
          .set({ quantity: new Decimal(twin.quantity).plus(line.quantity).toFixed(4) })
          .where(eq(assemblyComponents.id, twin.id));
        await tx.db.delete(assemblyComponents).where(eq(assemblyComponents.id, line.id));
        reassigned['assemblyComponents.combined'] = (reassigned['assemblyComponents.combined'] ?? 0) + 1;
      }
    }

    Object.assign(reassigned, await repointForeignKeys(tx, 'items', fromId, toId));
    reassigned.recurringTemplates = await rewriteTemplates(tx, fromId, toId);
    const moved = await moveNotesAndTodos(tx, 'item', fromId, toId);
    reassigned.todos = moved.todos;

    // Stock: the survivor now holds both quantities; average cost is the value-weighted mean.
    const newQty = fromQty.plus(toQty);
    const fromAvg = new Decimal(from.averageCost ?? 0);
    const toAvg = new Decimal(to.averageCost ?? 0);
    const newAvg = (newQty.isZero()
      ? (toQty.isZero() && !fromAvg.isZero() ? fromAvg : toAvg)
      : fromQty.times(fromAvg).plus(toQty.times(toAvg)).dividedBy(newQty)
    ).toDecimalPlaces(4, Decimal.ROUND_HALF_UP); // the column's scale: what is stored is what is valued
    let roundingEntryId: string | null = null;
    if (from.type === 'inventory' && averageCosted) {
      // Average cost is stored to 4 decimals, so quantity x average cost of the merged item can
      // differ from the two items' combined value by a few cents (100 @ 2.00 + 200 @ 1.00 = 400.00,
      // but 300 x 1.3333 = 399.99). Post that difference so the inventory asset account keeps
      // matching the inventory subledger (inventory valuation) exactly.
      const before = Money.round2(fromQty.times(fromAvg)).plus(Money.round2(toQty.times(toAvg)));
      const after = Money.round2(newQty.times(newAvg));
      const diff = after.minus(before);
      if (!diff.isZero()) {
        const invAcct = await inventoryAccountId(tx, to);
        const [cogs] = to.expenseAccountId
          ? [{ id: to.expenseAccountId }]
          : await tx.db
              .select({ id: accounts.id })
              .from(accounts)
              .where(and(eq(accounts.companyId, tx.companyId), eq(accounts.code, '5000')));
        if (!invAcct || !cogs) throw validation('Set up an inventory asset and cost of goods sold account before merging these items.');
        const amount = toAmountString(diff.abs());
        const memo = `Rounding from merging item "${from.name}" into "${to.name}"`;
        const entry = await postJournalEntry(tx, {
          date: new Date(),
          description: memo,
          sourceRef: `item:${toId}`,
          lines: diff.isPositive()
            ? [
                { accountId: invAcct, debit: amount, memo },
                { accountId: cogs.id, credit: amount, memo },
              ]
            : [
                { accountId: cogs.id, debit: amount, memo },
                { accountId: invAcct, credit: amount, memo },
              ],
        });
        roundingEntryId = entry.id;
      }
    }
    await tx.db
      .update(items)
      .set({
        quantityOnHand: newQty.toFixed(4),
        averageCost: from.type === 'inventory' ? newAvg.toFixed(4) : to.averageCost,
        updatedAt: new Date(),
      })
      .where(eq(items.id, toId));
    await tx.db
      .update(items)
      .set({ quantityOnHand: '0', isActive: false, barcode: null, updatedAt: new Date() })
      .where(eq(items.id, fromId));

    await writeAudit(tx, {
      action: 'delete',
      entityType: 'item',
      entityId: fromId,
      oldValues: { name: from.name, isActive: from.isActive, quantityOnHand: from.quantityOnHand, barcode: from.barcode },
      newValues: { isActive: false, quantityOnHand: '0', mergedInto: toId },
    });
    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: toId,
      oldValues: { quantityOnHand: to.quantityOnHand, averageCost: to.averageCost },
      newValues: { mergedFrom: fromId, quantityOnHand: newQty.toFixed(4), averageCost: newAvg.toFixed(4), reassigned, roundingEntryId },
    });
    return { reassigned, deactivatedId: fromId };
  });
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export async function mergeClasses(ctx: ServiceContext, { fromId, toId }: { fromId: string; toId: string }): Promise<ListMergeResult> {
  await assertListDeleteAllowed(ctx, 'merge', 'classes'); // Accountant's Copy (I1)
  if (fromId === toId) throw validation('Cannot merge a class with itself.');
  const load = async (id: string) => {
    const [row] = await ctx.db.select().from(classes).where(and(eq(classes.id, id), eq(classes.companyId, ctx.companyId)));
    if (!row) throw notFound(`Class ${id}`);
    return row;
  };
  const from = await load(fromId);
  const to = await load(toId);
  return inTransaction(ctx, async (tx) => {
    // If the survivor sits anywhere under the duplicate (child, grandchild, ...), lift it to the
    // duplicate's parent first; otherwise re-pointing the duplicate's children onto it would
    // close a loop (B under C under B).
    const tree = await tx.db
      .select({ id: classes.id, parentId: classes.parentId })
      .from(classes)
      .where(eq(classes.companyId, tx.companyId));
    const parentOf = new Map(tree.map((r) => [r.id, r.parentId]));
    const seen = new Set<string>();
    let cur: string | null | undefined = to.parentId;
    while (cur && !seen.has(cur)) {
      if (cur === fromId) {
        await tx.db.update(classes).set({ parentId: from.parentId ?? null }).where(eq(classes.id, toId));
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    const reassigned = await repointForeignKeys(tx, 'classes', fromId, toId);
    reassigned.recurringTemplates = await rewriteTemplates(tx, fromId, toId);
    await tx.db.update(classes).set({ isActive: false }).where(eq(classes.id, fromId));
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'class',
      entityId: fromId,
      oldValues: { name: from.name, isActive: from.isActive },
      newValues: { isActive: false, mergedInto: toId },
    });
    await writeAudit(tx, { action: 'update', entityType: 'class', entityId: toId, newValues: { mergedFrom: fromId, reassigned } });
    return { reassigned, deactivatedId: fromId };
  });
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export async function mergeEmployees(ctx: ServiceContext, { fromId, toId }: { fromId: string; toId: string }): Promise<ListMergeResult> {
  await assertListDeleteAllowed(ctx, 'merge', 'employees'); // Accountant's Copy (I1)
  if (fromId === toId) throw validation('Cannot merge an employee with themselves.');
  const load = async (id: string) => {
    const [row] = await ctx.db.select().from(employees).where(and(eq(employees.id, id), eq(employees.companyId, ctx.companyId)));
    if (!row) throw notFound(`Employee ${id}`);
    return row;
  };
  const from = await load(fromId);
  const to = await load(toId);
  const paid = async (id: string) =>
    (await ctx.db.select({ id: paychecks.id }).from(paychecks).where(eq(paychecks.employeeId, id)).limit(1)).length > 0;
  if ((await paid(fromId)) && (await paid(toId))) {
    throw validation(
      'Both employees have paychecks. Merging them would combine two people\'s wages and tax forms, so it is not allowed.',
    );
  }
  return inTransaction(ctx, async (tx) => {
    const reassigned = await repointForeignKeys(tx, 'employees', fromId, toId);
    reassigned.recurringTemplates = await rewriteTemplates(tx, fromId, toId);
    const moved = await moveNotesAndTodos(tx, 'employee', fromId, toId);
    reassigned.notes = moved.notes;
    reassigned.todos = moved.todos;
    await tx.db.update(employees).set({ isActive: false, updatedAt: new Date() }).where(eq(employees.id, fromId));
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'employee',
      entityId: fromId,
      oldValues: { name: `${from.firstName} ${from.lastName}`, isActive: from.isActive },
      newValues: { isActive: false, mergedInto: toId },
    });
    await writeAudit(tx, {
      action: 'update',
      entityType: 'employee',
      entityId: toId,
      newValues: { mergedFrom: fromId, name: `${to.firstName} ${to.lastName}`, reassigned },
    });
    return { reassigned, deactivatedId: fromId };
  });
}

// ---------------------------------------------------------------------------
// Other names
// ---------------------------------------------------------------------------

export async function mergeOtherNames(ctx: ServiceContext, { fromId, toId }: { fromId: string; toId: string }): Promise<ListMergeResult> {
  await assertListDeleteAllowed(ctx, 'merge', 'other names'); // Accountant's Copy (I1)
  if (fromId === toId) throw validation('Cannot merge a name with itself.');
  const load = async (id: string) => {
    const [row] = await ctx.db.select().from(otherNames).where(and(eq(otherNames.id, id), eq(otherNames.companyId, ctx.companyId)));
    if (!row) throw notFound(`Other name ${id}`);
    return row;
  };
  const from = await load(fromId);
  const to = await load(toId);
  return inTransaction(ctx, async (tx) => {
    // Re-points expenses.other_name_id (B3, drizzle/0055) and every other foreign key.
    const reassigned = await repointForeignKeys(tx, 'other_names', fromId, toId);
    // Checks / expenses written to an other name also carry the payee as text: rename those
    // linked to the merged entry, and legacy free-text checks typed with its name.
    const renamed = await tx.db
      .update(expenses)
      .set({ payeeName: to.name })
      .where(
        and(
          eq(expenses.companyId, tx.companyId),
          sql`${expenses.vendorId} IS NULL`,
          sql`(${expenses.otherNameId} = ${toId} AND ${expenses.payeeName} = ${from.name} OR ${expenses.otherNameId} IS NULL AND ${expenses.payeeName} = ${from.name})`,
        ),
      )
      .returning({ id: expenses.id });
    reassigned.expensesPayee = renamed.length;
    // The QB "Name" column on journal lines (General Journal lines naming an other name). The id
    // was verified to belong to this company; accounts and amounts are untouched.
    await allowLedgerRewrite(tx, 'merge');
    const lines = await tx.db
      .update(journalEntryLines)
      .set({ entityId: toId })
      .where(and(eq(journalEntryLines.entityType, 'other'), eq(journalEntryLines.entityId, fromId)))
      .returning({ id: journalEntryLines.id });
    if (lines.length) reassigned.journalLineNames = lines.length;
    const moved = await moveNotesAndTodos(tx, 'other_name', fromId, toId);
    reassigned.notes = moved.notes;
    reassigned.todos = moved.todos;
    await tx.db.update(otherNames).set({ isActive: false, updatedAt: new Date() }).where(eq(otherNames.id, fromId));
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'other_name',
      entityId: fromId,
      oldValues: { name: from.name, isActive: from.isActive },
      newValues: { isActive: false, mergedInto: toId },
    });
    await writeAudit(tx, { action: 'update', entityType: 'other_name', entityId: toId, newValues: { mergedFrom: fromId, reassigned } });
    return { reassigned, deactivatedId: fromId };
  });
}
