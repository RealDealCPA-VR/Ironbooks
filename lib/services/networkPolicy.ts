/**
 * Persistence for the per-company network policy (see lib/net/policy.ts for the rules).
 *
 * Stored in companies.settings.networkPolicy. The generic updateCompany() settings whitelist
 * does NOT include this key, so the only way to change it is setNetworkPolicy() below, which is
 * owner/admin-only and audited.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { companies } from '@/lib/db/schema';
import {
  DEFAULT_NETWORK_POLICY,
  NETWORK_MODES,
  OUTBOUND_PURPOSES,
  normalizePolicy,
  type NetworkPolicy,
} from '@/lib/net/policy';
import { type ServiceContext, ServiceError, inTransaction, notFound, writeAudit } from './_base';

export const SETTINGS_KEY = 'networkPolicy';

/**
 * Stored-policy revision. Before rev 2 update checks were opt-in and every saved policy carried
 * updates: false; those saves were never a real choice, so pre-rev-2 policies read as updates on.
 */
const POLICY_REV = 2;

function readStored(raw: unknown): NetworkPolicy {
  const policy = normalizePolicy(raw);
  const rev = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).rev : undefined;
  if (rev !== POLICY_REV) policy.cloudOptIn.updates = true;
  return policy;
}

export const networkPolicySchema = z.object({
  mode: z.enum(NETWORK_MODES),
  cloudOptIn: z
    .object(
      Object.fromEntries(OUTBOUND_PURPOSES.map((p) => [p, z.boolean().optional()])) as Record<
        (typeof OUTBOUND_PURPOSES)[number],
        z.ZodOptional<z.ZodBoolean>
      >,
    )
    .partial()
    .optional(),
});
export type NetworkPolicyInput = z.infer<typeof networkPolicySchema>;

/** The active company's policy (defaults when never configured: tailnet-only, no cloud, update checks on). */
export async function getNetworkPolicy(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<NetworkPolicy> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  if (!row) return normalizePolicy(DEFAULT_NETWORK_POLICY);
  return readStored((row.settings as Record<string, unknown> | null)?.[SETTINGS_KEY]);
}

/** Owner/admin only (trusted internal contexts without a role pass). */
function assertCanManage(ctx: ServiceContext): void {
  if (ctx.role && ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new ServiceError('FORBIDDEN', 'Only an owner or admin can change privacy and network settings.');
  }
}

/**
 * Replace the company's network policy. Opt-ins are only meaningful in 'allow-cloud' mode;
 * they are persisted as given so switching modes back and forth keeps the user's choices.
 */
export async function setNetworkPolicy(ctx: ServiceContext, input: unknown): Promise<NetworkPolicy> {
  assertCanManage(ctx);
  const parsed = networkPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw new ServiceError('VALIDATION', 'Invalid network policy.', parsed.error.flatten());
  }
  const next = normalizePolicy(parsed.data);

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, tx.companyId));
    if (!row) throw notFound('Company');
    const settings = { ...((row.settings ?? {}) as Record<string, unknown>) };
    const before = readStored(settings[SETTINGS_KEY]);
    settings[SETTINGS_KEY] = { ...next, rev: POLICY_REV };
    await tx.db
      .update(companies)
      .set({ settings, updatedAt: new Date() })
      .where(eq(companies.id, tx.companyId));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'network_policy',
      entityId: tx.companyId,
      oldValues: before,
      newValues: next,
    });
    return next;
  });
}
