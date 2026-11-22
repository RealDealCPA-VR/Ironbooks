/**
 * Zod schemas for /api/fixed-assets — mirrors CreateAssetInput and the
 * depreciate action body (lib/services/fixedAssets.ts).
 */
import { z } from 'zod';
import { zDate, zMoney, zUuid } from './helpers';

export const createAssetSchema = z.object({
  name: z
    .string({ required_error: 'Missing required field: name' })
    .min(1, 'name is required')
    .describe('Name of the asset, such as "Delivery van".'),
  cost: zMoney.describe('What the asset cost, as decimal text above zero such as "12000.00".'),
  salvageValue: zMoney
    .nullish()
    .describe('What it is expected to be worth at the end of its useful life, as decimal text below cost; leave out for "0.00".'),
  /** The route historically coerced (Number(body.usefulLifeMonths)); keep that. */
  usefulLifeMonths: z.coerce
    .number({ invalid_type_error: 'usefulLifeMonths must be a number' })
    .int('usefulLifeMonths must be an integer')
    .positive('usefulLifeMonths must be positive')
    .describe('Useful life in whole months, such as 60 for five years; straight-line depreciation spreads cost less salvage over it.'),
  placedInService: zDate.describe('Date the asset was placed in service, YYYY-MM-DD; depreciation runs monthly from it.'),
  depreciationExpenseAccountId: zUuid
    .nullish()
    .describe('Id of the expense account (chart of accounts) depreciation posts to; leave out for Depreciation Expense (6800).'),
  accumulatedDepreciationAccountId: zUuid
    .nullish()
    .describe('Id of the accumulated depreciation account (chart of accounts) depreciation is credited to; leave out for Accumulated Depreciation (1590).'),
  assetAccountId: zUuid
    .nullish()
    .describe('Id of the fixed asset account (chart of accounts) the asset is kept in, for reference; leave out for none. Adding the asset posts no entry.'),
});
export type CreateAssetBody = z.infer<typeof createAssetSchema>;

/** POST /api/fixed-assets/:id — { action: 'depreciate', date }. */
export const fixedAssetActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z
      .literal('depreciate')
      .describe('depreciate: post one month of straight-line depreciation (never past cost less salvage).'),
    date: zDate.describe('Date of the depreciation entry, YYYY-MM-DD.'),
  }),
]);
export type FixedAssetActionBody = z.infer<typeof fixedAssetActionSchema>;
