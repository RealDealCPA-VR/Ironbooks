/**
 * Persistence for the per-company network policy (see lib/net/policy.ts for the rules).
 *
 * Stored in companies.settings.networkPolicy. The generic updateCompany() settings whitelist
 * does NOT include this key, so the only way to change it is setNetworkPolicy() below, which is
 * owner/admin-only and audited.
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { companies } from '@/lib/db/schema';
import {
  DEFAULT_NETWORK_POLICY,
  NETWORK_MODES,
  OUTBOUND_PURPOSES,
  envModeCeiling,
  normalizeLookupUrl,
  normalizePolicy,
  type NetworkPolicy,
  type OutboundPurpose,
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
  /** Your SearXNG base URL for vendor lookup ('' or null clears it). */
  vendorLookupUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || normalizeLookupUrl(v) !== null, 'Enter a plain http(s) address, e.g. http://searx.tail1234.ts.net:8080')
    .nullish(),
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
 * Let one cloud service through — what "Allow cloud AI" on the AI page does, so a person who
 * adds Claude or ChatGPT there never has to find Privacy & Network as well. Moves the mode up
 * to 'allow-cloud' (never out of 'offline': that choice is deliberate, so it is reported
 * instead) and turns the purpose on. Returns what changed, and a note when it could not.
 */
export async function allowCloudPurpose(
  ctx: ServiceContext,
  purpose: OutboundPurpose,
): Promise<{ changed: boolean; notice: string | null }> {
  const current = await getNetworkPolicy(ctx);
  const ceiling = envModeCeiling();
  if (ceiling && ceiling !== 'allow-cloud') {
    return { changed: false, notice: `This computer is limited to "${ceiling}" network mode (BKA_NETWORK_MODE), so cloud AI cannot be used here.` };
  }
  if (current.mode === 'offline') {
    return {
      changed: false,
      notice: 'This company is in Offline mode, so cloud AI stays blocked. Choose "Allow cloud services I choose" in Settings → Privacy & Network to use it.',
    };
  }
  if (current.mode === 'allow-cloud' && current.cloudOptIn[purpose]) return { changed: false, notice: null };
  await setNetworkPolicy(ctx, {
    mode: 'allow-cloud',
    cloudOptIn: { ...current.cloudOptIn, [purpose]: true },
    vendorLookupUrl: current.vendorLookupUrl,
  });
  return { changed: true, notice: null };
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
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    const before = readStored(settings[SETTINGS_KEY]);
    const stored = { ...next, rev: POLICY_REV };
    // Merge only this key in SQL: writing back the whole object read above could undo a
    // concurrent closing date, password policy or file lock (prefsperms review P2).
    await tx.db
      .update(companies)
      .set({
        settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object(${SETTINGS_KEY}::text, ${JSON.stringify(stored)}::jsonb)`,
        updatedAt: new Date(),
      })
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
