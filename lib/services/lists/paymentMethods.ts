/**
 * Payment Method list ↔ payment_method enum compatibility.
 *
 * Documents (payments received, sales receipts, bill payments, expenses) keep storing the
 * `payment_method` enum in their `method` column. A custom list entry such as "Visa" maps to its
 * enum `type` ('credit_card'), so deposits and reports keep grouping correctly. Integration hook
 * for the sales / purchases teams: accept a list entry id (or name) from the form and store
 * `(await resolvePaymentMethod(ctx, ref)).type` in `method` (plus the entry id where a column exists).
 */
import { and, eq, sql } from 'drizzle-orm';
import { paymentMethods } from '@/lib/db/schema';
import { type ServiceContext, notFound } from '../_base';
import { ensureSeeded } from './simpleLists';

export type PaymentMethodType = 'cash' | 'check' | 'credit_card' | 'ach' | 'bank_transfer' | 'other';
const ENUM_VALUES: readonly PaymentMethodType[] = ['cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedPaymentMethod {
  id: string | null;
  name: string;
  type: PaymentMethodType;
}

/**
 * Resolve a payment method reference — a list entry id, an entry name ("Visa"), or a raw enum
 * value ('check') — to its list entry and enum type. Unknown references throw NOT_FOUND.
 */
export async function resolvePaymentMethod(ctx: ServiceContext, ref: string): Promise<ResolvedPaymentMethod> {
  const value = ref.trim();
  await ensureSeeded(ctx, 'payment-methods');
  const scope = eq(paymentMethods.companyId, ctx.companyId);
  if (UUID_RE.test(value)) {
    const [row] = await ctx.db.select().from(paymentMethods).where(and(scope, eq(paymentMethods.id, value)));
    if (row) return { id: row.id, name: row.name, type: row.type as PaymentMethodType };
  }
  const [byName] = await ctx.db
    .select()
    .from(paymentMethods)
    .where(and(scope, sql`lower(${paymentMethods.name}) = lower(${value})`));
  if (byName) return { id: byName.id, name: byName.name, type: byName.type as PaymentMethodType };
  if ((ENUM_VALUES as readonly string[]).includes(value)) {
    return { id: null, name: value.replace('_', ' '), type: value as PaymentMethodType };
  }
  throw notFound(`Payment method "${value}"`);
}
