/**
 * Client-safe advanced-pricing types and constants (no database imports), shared by
 * lib/services/pricing.ts, the zod schemas and the UI.
 */

export const ROUNDING_MODES = [
  'none', // nearest cent
  'nearest_0.05',
  'nearest_0.10',
  'nearest_0.25',
  'nearest_0.50',
  'nearest_1.00',
  'up_0.05',
  'up_0.10',
  'up_1.00',
  'down_0.05',
  'down_0.10',
  'down_1.00',
  'up_0.99',
  'down_0.99',
  'nearest_0.99',
] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const ROUNDING_LABELS: Record<RoundingMode, string> = {
  none: 'Nearest cent',
  'nearest_0.05': 'Nearest .05',
  'nearest_0.10': 'Nearest .10',
  'nearest_0.25': 'Nearest .25',
  'nearest_0.50': 'Nearest .50',
  'nearest_1.00': 'Nearest whole dollar',
  'up_0.05': 'Up to .05',
  'up_0.10': 'Up to .10',
  'up_1.00': 'Up to whole dollar',
  'down_0.05': 'Down to .05',
  'down_0.10': 'Down to .10',
  'down_1.00': 'Down to whole dollar',
  'up_0.99': 'Up to .99',
  'down_0.99': 'Down to .99',
  'nearest_0.99': 'Nearest .99',
};

export type ConflictMode = 'lowest' | 'priority';

export interface PriceAdjustment {
  /** What the adjustment is computed from. Ignored for 'fixed'. */
  basis: 'price' | 'cost';
  method: 'percent' | 'amount' | 'fixed';
  /** Ignored for 'fixed'. */
  direction: 'increase' | 'decrease';
  /** Percent (10 = 10%), dollar amount, or the fixed price. Non-negative. */
  value: string;
}

export interface PriceTier {
  /** The tier applies when the line quantity >= minQuantity. */
  minQuantity: string;
  adjustment: PriceAdjustment;
}

/** Every non-empty list must match (AND across dimensions, OR within a list). */
export interface PriceRuleConditions {
  itemIds?: string[];
  itemTypes?: string[];
  /** Matches items whose custom field `name` equals `value` (case-insensitive, trimmed). */
  itemCustomField?: { name: string; value: string } | null;
  /** Matches the customer or any of its parent customers (sub-customers/jobs inherit). */
  customerIds?: string[];
  customerTypeIds?: string[];
  jobIds?: string[];
  classIds?: string[];
  salesRepIds?: string[];
}

export type PriceSource = 'base' | 'customer_price' | 'price_level' | 'price_rule';

export interface PriceCandidate {
  source: Exclude<PriceSource, 'base'>;
  id: string;
  name: string;
  price: string;
  /** Rule priority (rules only). */
  priority: number | null;
  tierMinQuantity: string | null;
}

export interface PriceQuote {
  itemId: string;
  quantity: string;
  /** Item's base sales price (2dp). */
  basePrice: string;
  /** Resolved unit price (2dp). */
  price: string;
  source: PriceSource;
  ruleId: string | null;
  ruleName: string | null;
  priceLevelId: string | null;
  priceLevelName: string | null;
  tierMinQuantity: string | null;
  /** Short human-readable explanation for the UI indicator. */
  label: string;
  /** Every candidate considered (for the "why this price?" popover). */
  candidates: PriceCandidate[];
}

/** Provenance persisted on document lines (`pricing` jsonb). */
export interface AppliedPricing {
  source: PriceSource | 'manual';
  ruleId: string | null;
  ruleName: string | null;
  priceLevelId: string | null;
  priceLevelName: string | null;
  tierMinQuantity: string | null;
  basePrice: string;
  /** The price the pricing engine computed. */
  expectedPrice: string;
  /** True when the user typed a different price than the engine computed. */
  overridden: boolean;
  label: string;
  /** Where a carried-over price came from (e.g. 'sales_order', 'estimate'). */
  origin?: string | null;
}
