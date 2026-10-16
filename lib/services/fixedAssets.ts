/**
 * Fixed Assets service — QB Fixed Asset Manager equivalent.
 *
 * Supports:
 *  - listAssets      — list all fixed assets for the company
 *  - createAsset     — record a new fixed asset
 *  - getAsset        — fetch a single asset (with depreciation entry history)
 *  - depreciationSchedule — compute the full straight-line schedule (no GL writes)
 *  - postDepreciation     — record one period of depreciation, write to GL
 *
 * Straight-line formula:
 *   monthlyAmount = (cost - salvageValue) / usefulLifeMonths
 *
 * GL posting (postDepreciation):
 *   Dr  6800  Depreciation Expense           (get-or-create)
 *   Cr  1590  Accumulated Depreciation       (get-or-create, contra-asset)
 *
 * Guard: accumulated depreciation cannot exceed (cost - salvageValue). Any attempt
 * to depreciate past full depreciation posts only the remaining balance.
 */

import { and, eq, sql } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import { accounts, fixedAssets, depreciationEntries } from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry } from './posting';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateAssetInput {
  name: string;
  /** Total acquisition cost (e.g. 12000). */
  cost: string | number;
  /** Residual / salvage value at end of useful life. Defaults to 0. */
  salvageValue?: string | number | null;
  /** Useful life in months (e.g. 60 = 5 years). */
  usefulLifeMonths: number;
  /** Date the asset was placed in service. */
  placedInService: Date;
  /** Optional: override the depreciation expense GL account (defaults to code 6800). */
  depreciationExpenseAccountId?: string | null;
  /** Optional: override the accumulated depreciation contra account (defaults to code 1590). */
  accumulatedDepreciationAccountId?: string | null;
  /** Optional: link to the asset GL account (code 1500 area). */
  assetAccountId?: string | null;
}

export interface DepreciationScheduleItem {
  /** 1-based period number. */
  period: number;
  /** Date of this period's depreciation (monthly from placedInService). */
  date: Date;
  /** Amount to depreciate this period. */
  amount: string;
  /** Cumulative accumulated depreciation after this period. */
  accumulated: string;
  /** Net book value after this period. */
  netBookValue: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up an account by code, creating it if it does not exist.
 * `type` must match Drizzle enum literals: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'.
 */
async function getOrCreateAccount(
  ctx: ServiceContext,
  code: string,
  def: { name: string; type: string; subtype: string },
): Promise<string> {
  const [existing] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (existing) return existing.id;

  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code,
      name: def.name,
      type: def.type as never,
      subtype: def.subtype as never,
    })
    .returning();
  return created.id;
}

// ---------------------------------------------------------------------------
// listAssets
// ---------------------------------------------------------------------------

export async function listAssets(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(fixedAssets)
    .where(eq(fixedAssets.companyId, ctx.companyId))
    .orderBy(fixedAssets.createdAt);
}

// ---------------------------------------------------------------------------
// createAsset
// ---------------------------------------------------------------------------

export async function createAsset(ctx: ServiceContext, input: CreateAssetInput) {
  const cost = Money.round2(input.cost);
  if (cost.lessThanOrEqualTo(0)) throw validation('Asset cost must be positive.');

  const salvage = Money.round2(input.salvageValue ?? 0);
  if (salvage.lessThan(0)) throw validation('Salvage value cannot be negative.');
  if (salvage.greaterThanOrEqualTo(cost)) throw validation('Salvage value must be less than cost.');

  if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths < 1) {
    throw validation('usefulLifeMonths must be a positive integer.');
  }

  // Resolve optional account overrides — just verify they belong to this company.
  for (const accountId of [
    input.depreciationExpenseAccountId,
    input.accumulatedDepreciationAccountId,
    input.assetAccountId,
  ].filter(Boolean) as string[]) {
    const [row] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
    if (!row) throw notFound(`Account ${accountId}`);
  }

  const [asset] = await ctx.db
    .insert(fixedAssets)
    .values({
      companyId: ctx.companyId,
      name: input.name.trim(),
      cost: toAmountString(cost),
      salvageValue: toAmountString(salvage),
      usefulLifeMonths: input.usefulLifeMonths,
      placedInService: input.placedInService,
      accumulatedDepreciation: '0.00',
      method: 'straight_line',
      assetAccountId: input.assetAccountId ?? null,
      depreciationExpenseAccountId: input.depreciationExpenseAccountId ?? null,
      accumulatedDepreciationAccountId: input.accumulatedDepreciationAccountId ?? null,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'fixed_asset',
    entityId: asset.id,
    newValues: {
      name: asset.name,
      cost: asset.cost,
      salvageValue: asset.salvageValue,
      usefulLifeMonths: asset.usefulLifeMonths,
      placedInService: asset.placedInService,
    },
  });

  return asset;
}

// ---------------------------------------------------------------------------
// getAsset
// ---------------------------------------------------------------------------

export async function getAsset(ctx: ServiceContext, id: string) {
  const [asset] = await ctx.db
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.companyId, ctx.companyId), eq(fixedAssets.id, id)));
  if (!asset) throw notFound('Fixed asset');

  const entries = await ctx.db
    .select()
    .from(depreciationEntries)
    .where(
      and(
        eq(depreciationEntries.companyId, ctx.companyId),
        eq(depreciationEntries.fixedAssetId, id),
      ),
    )
    .orderBy(depreciationEntries.date);

  return { ...asset, depreciationEntries: entries };
}

// ---------------------------------------------------------------------------
// depreciationSchedule
// ---------------------------------------------------------------------------

/**
 * Compute the full straight-line depreciation schedule for an asset.
 * Does not read or write the database — pure computation.
 */
export function depreciationSchedule(asset: {
  cost: string | number;
  salvageValue: string | number;
  usefulLifeMonths: number;
  placedInService: Date;
}): DepreciationScheduleItem[] {
  const cost = Money.of(asset.cost);
  const salvage = Money.of(asset.salvageValue);
  const depreciableBase = cost.minus(salvage);
  const months = asset.usefulLifeMonths;

  // Monthly amount: evenly distribute over life, final period absorbs rounding remainder.
  const monthlyRaw = depreciableBase.dividedBy(months);
  const monthlyAmount = Money.round2(monthlyRaw);

  const schedule: DepreciationScheduleItem[] = [];
  let accumulated = Money.zero();

  for (let p = 1; p <= months; p++) {
    // On the last period, use whatever remains to avoid rounding drift.
    const isLast = p === months;
    const remaining = depreciableBase.minus(accumulated);
    const periodAmount = isLast ? Money.round2(remaining) : monthlyAmount;

    accumulated = accumulated.plus(periodAmount);

    // Compute the date for this period: placedInService + p months.
    const d = new Date(asset.placedInService);
    d.setMonth(d.getMonth() + p);

    schedule.push({
      period: p,
      date: d,
      amount: toAmountString(periodAmount),
      accumulated: toAmountString(accumulated),
      netBookValue: toAmountString(cost.minus(accumulated)),
    });
  }

  return schedule;
}

// ---------------------------------------------------------------------------
// postDepreciation
// ---------------------------------------------------------------------------

export interface PostDepreciationInput {
  assetId: string;
  /** The accounting date for this depreciation entry. */
  date: Date;
}

/**
 * Post one period of straight-line depreciation for an asset.
 *
 * Steps:
 *  1. Load the asset; verify it belongs to the company.
 *  2. Compute the monthly amount = (cost - salvage) / usefulLifeMonths.
 *  3. Guard: if accumulated depreciation is already at (cost - salvage), throw VALIDATION.
 *  4. Clamp: if the monthly amount would push accumulated past the depreciable base, use the remainder.
 *  5. Resolve or create the depreciation expense account (code 6800).
 *  6. Resolve or create the accumulated depreciation contra account (code 1590).
 *  7. Post the GL entry via postJournalEntry.
 *  8. Insert a depreciationEntries row.
 *  9. Bump fixedAssets.accumulatedDepreciation.
 */
export async function postDepreciation(ctx: ServiceContext, input: PostDepreciationInput) {
  const { assetId, date } = input;

  const [asset] = await ctx.db
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.companyId, ctx.companyId), eq(fixedAssets.id, assetId)));
  if (!asset) throw notFound('Fixed asset');

  const cost = Money.of(asset.cost);
  const salvage = Money.of(asset.salvageValue);
  const depreciableBase = cost.minus(salvage);
  const alreadyAccumulated = Money.of(asset.accumulatedDepreciation);

  // Guard: already fully depreciated.
  if (alreadyAccumulated.greaterThanOrEqualTo(depreciableBase)) {
    throw new ServiceError(
      'VALIDATION',
      `Asset "${asset.name}" is already fully depreciated (accumulated ${toAmountString(alreadyAccumulated)} of ${toAmountString(depreciableBase)}).`,
    );
  }

  // Standard monthly amount.
  const monthlyAmount = Money.round2(depreciableBase.dividedBy(asset.usefulLifeMonths));

  // Clamp to remaining depreciable amount to avoid over-depreciation.
  const remaining = depreciableBase.minus(alreadyAccumulated);
  // The asset's last useful-life period takes whatever remains (as depreciationSchedule does), so
  // a rounded-down monthly amount never leaves a cent to depreciate after the useful life ends.
  const postedPeriods = (
    await ctx.db
      .select({ id: depreciationEntries.id })
      .from(depreciationEntries)
      .where(and(eq(depreciationEntries.companyId, ctx.companyId), eq(depreciationEntries.fixedAssetId, assetId)))
  ).length;
  const isLastPeriod = postedPeriods + 1 >= asset.usefulLifeMonths;
  const periodAmount =
    isLastPeriod || monthlyAmount.greaterThan(remaining) ? Money.round2(remaining) : monthlyAmount;

  // Resolve GL accounts (use overrides if the asset has them; otherwise get-or-create defaults).
  const depExpenseAccountId =
    asset.depreciationExpenseAccountId ??
    (await getOrCreateAccount(ctx, '6800', {
      name: 'Depreciation Expense',
      type: 'expense',
      subtype: 'operating_expenses',
    }));

  const accumDepAccountId =
    asset.accumulatedDepreciationAccountId ??
    (await getOrCreateAccount(ctx, '1590', {
      name: 'Accumulated Depreciation',
      type: 'asset',
      subtype: 'fixed_assets',
    }));

  return inTransaction(ctx, async (tx) => {
    // Idempotency guard: refuse to post the same asset's depreciation twice for the same
    // date (e.g. a double-clicked "Run depreciation" or a re-run monthly job). Checked inside
    // the transaction so concurrent posts can't both pass.
    const [dup] = await tx.db
      .select({ id: depreciationEntries.id })
      .from(depreciationEntries)
      .where(
        and(
          eq(depreciationEntries.companyId, tx.companyId),
          eq(depreciationEntries.fixedAssetId, assetId),
          eq(depreciationEntries.date, date),
        ),
      );
    if (dup) {
      throw new ServiceError(
        'CONFLICT',
        `Depreciation for "${asset.name}" on ${date.toISOString().slice(0, 10)} has already been posted.`,
      );
    }

    // Post GL entry: Dr Depreciation Expense / Cr Accumulated Depreciation.
    const entry = await postJournalEntry(tx, {
      date,
      description: `Depreciation — ${asset.name}`,
      reference: assetId,
      sourceRef: `fixed_asset:${assetId}`,
      lines: [
        {
          accountId: depExpenseAccountId,
          debit: toAmountString(periodAmount),
          memo: `Depreciation expense — ${asset.name}`,
        },
        {
          accountId: accumDepAccountId,
          credit: toAmountString(periodAmount),
          memo: `Accumulated depreciation — ${asset.name}`,
        },
      ],
    });

    // Insert depreciation entry record.
    const [depEntry] = await tx.db
      .insert(depreciationEntries)
      .values({
        companyId: tx.companyId,
        fixedAssetId: assetId,
        date,
        amount: toAmountString(periodAmount),
        postedEntryId: entry.id,
      })
      .returning();

    // Bump accumulatedDepreciation on the asset.
    const newAccumulated = toAmountString(alreadyAccumulated.plus(periodAmount));
    await tx.db
      .update(fixedAssets)
      .set({ accumulatedDepreciation: newAccumulated })
      .where(eq(fixedAssets.id, assetId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'fixed_asset',
      entityId: assetId,
      oldValues: { accumulatedDepreciation: toAmountString(alreadyAccumulated) },
      newValues: {
        accumulatedDepreciation: newAccumulated,
        depreciationEntryId: depEntry.id,
        journalEntryId: entry.id,
      },
    });

    return {
      depreciationEntry: depEntry,
      journalEntry: entry,
      periodAmount: toAmountString(periodAmount),
      newAccumulatedDepreciation: newAccumulated,
    };
  });
}
