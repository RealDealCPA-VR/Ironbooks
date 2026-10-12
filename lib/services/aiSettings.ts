/**
 * AI settings service — per-company provider configuration, routing policies and automation
 * thresholds, plus the factory that turns those settings into a live AiRouter.
 *
 * Security:
 *  - API keys are encrypted at rest (lib/ai/keyVault) and are write-only through this
 *    service: `getPublicSettings` returns `hasApiKey`, never the key.
 *  - Changing settings or testing a connection requires admin/owner.
 *  - Cloud calls are opt-in per company (`cloudEnabled`, default false) and always redacted
 *    with a company-aware Redactor built from the customer/vendor/employee lists.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { aiSettings, customers, employees, vendors } from '@/lib/db/schema';
import { type ServiceContext, validation, writeAudit, inTransaction } from './_base';
import { requireRole } from './rbac';
import { AiRouter } from '@/lib/ai/router';
import { createProvider, localityOf, type ProviderDeps } from '@/lib/ai/providers';
import { classifyEndpoint } from '@/lib/ai/tailnet';
import { decryptSecret, encryptSecret } from '@/lib/ai/keyVault';
import { Redactor, addressEntities, type KnownEntity } from '@/lib/ai/redact';
import {
  AI_TASKS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_POLICY,
  PROVIDER_KINDS,
  ROUTING_POLICIES,
  type AiProvider,
  type AiTask,
  type ModelInfo,
  type ProviderRuntimeConfig,
  type PublicProviderConfig,
  type RoutingPolicy,
  type StoredProviderConfig,
} from '@/lib/ai/types';

export interface AiSettingsView {
  providers: PublicProviderConfig[];
  taskPolicies: Record<AiTask, RoutingPolicy>;
  cloudEnabled: boolean;
  autoApplyEnabled: boolean;
  /** 0..1 as a decimal string, e.g. "0.9500". */
  autoApplyThreshold: string;
  llmSuggestEnabled: boolean;
}

interface SettingsRecord {
  providers: StoredProviderConfig[];
  taskPolicies: Record<AiTask, RoutingPolicy>;
  cloudEnabled: boolean;
  autoApplyEnabled: boolean;
  autoApplyThreshold: string;
  llmSuggestEnabled: boolean;
}

const DEFAULTS: SettingsRecord = {
  providers: [],
  taskPolicies: { categorize: DEFAULT_POLICY, assistant: DEFAULT_POLICY, 'error-correction': DEFAULT_POLICY },
  cloudEnabled: false,
  autoApplyEnabled: false,
  autoApplyThreshold: '0.9500',
  llmSuggestEnabled: true,
};

function normalizePolicies(raw: Record<string, string> | null | undefined): Record<AiTask, RoutingPolicy> {
  const out = { ...DEFAULTS.taskPolicies };
  for (const t of AI_TASKS) {
    const v = raw?.[t];
    if (v && (ROUTING_POLICIES as string[]).includes(v)) out[t] = v as RoutingPolicy;
  }
  return out;
}

/** Load the raw settings record (defaults when the company has none yet). Read-only. */
export async function loadSettings(ctx: ServiceContext): Promise<SettingsRecord> {
  const [row] = await ctx.db.select().from(aiSettings).where(eq(aiSettings.companyId, ctx.companyId));
  if (!row) return { ...DEFAULTS, taskPolicies: { ...DEFAULTS.taskPolicies } };
  return {
    providers: (row.providers as unknown as StoredProviderConfig[]) ?? [],
    taskPolicies: normalizePolicies(row.taskPolicies),
    cloudEnabled: row.cloudEnabled,
    autoApplyEnabled: row.autoApplyEnabled,
    autoApplyThreshold: row.autoApplyThreshold,
    llmSuggestEnabled: row.llmSuggestEnabled,
  };
}

function toPublic(p: StoredProviderConfig, companyId: string): PublicProviderConfig {
  const { apiKeyEnc, ...rest } = p;
  const ep = p.kind === 'anthropic' && !p.baseUrl ? null : classifyEndpoint(p.baseUrl);
  const unreadable = !!apiKeyEnc && decryptSecret(apiKeyEnc, companyId) === null;
  return {
    ...rest,
    hasApiKey: !!apiKeyEnc && !unreadable,
    ...(unreadable ? { apiKeyUnreadable: true } : {}),
    locality: localityOf(p),
    hostClass: ep?.hostClass ?? null,
    warning: ep?.warning ?? null,
  };
}

/** Settings as the client may see them — key material stripped. */
export async function getPublicSettings(ctx: ServiceContext): Promise<AiSettingsView> {
  const s = await loadSettings(ctx);
  return {
    providers: s.providers.map((p) => toPublic(p, ctx.companyId)),
    taskPolicies: s.taskPolicies,
    cloudEnabled: s.cloudEnabled,
    autoApplyEnabled: s.autoApplyEnabled,
    autoApplyThreshold: s.autoApplyThreshold,
    llmSuggestEnabled: s.llmSuggestEnabled,
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export const providerInputSchema = z.object({
  /** Omit for a new provider. */
  id: z.string().min(1).max(64).optional(),
  kind: z.enum(PROVIDER_KINDS as [string, ...string[]]),
  label: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().max(500).nullish(),
  model: z.string().trim().max(200).default(''),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(600_000).nullish(),
  /** Write-only plaintext key. Omit to keep the stored key. */
  apiKey: z.string().max(500).optional(),
  /** true → delete the stored key. */
  clearApiKey: z.boolean().optional(),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;

export const updateSettingsSchema = z.object({
  providers: z.array(providerInputSchema).max(20).optional(),
  taskPolicies: z.record(z.enum(ROUTING_POLICIES as [string, ...string[]])).optional(),
  cloudEnabled: z.boolean().optional(),
  autoApplyEnabled: z.boolean().optional(),
  autoApplyThreshold: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => Number.isFinite(v) && v >= 0.5 && v <= 1, 'threshold must be between 0.50 and 1.00')
    .optional(),
  llmSuggestEnabled: z.boolean().optional(),
});
export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;

function validateProvider(p: ProviderInput): void {
  if (p.kind !== 'anthropic') {
    if (!p.baseUrl) throw validation(`${p.label}: a base URL is required (e.g. http://gpu-box.tail1234.ts.net:11434).`);
    const ep = classifyEndpoint(p.baseUrl);
    if (ep.hostClass === 'invalid' || !ep.protocol) throw validation(`${p.label}: ${ep.warning ?? 'invalid URL'}`);
    if (!p.model) throw validation(`${p.label}: pick a model.`);
  } else if (p.baseUrl) {
    const ep = classifyEndpoint(p.baseUrl);
    if (ep.protocol !== 'https') throw validation(`${p.label}: a custom Anthropic base URL must use HTTPS.`);
  }
}

export async function updateSettings(ctx: ServiceContext, input: UpdateSettingsInput): Promise<AiSettingsView> {
  await requireRole(ctx, 'admin');
  const parsed = updateSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw validation(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const body = parsed.data;
  const current = await loadSettings(ctx);
  const next: SettingsRecord = { ...current };

  if (body.providers) {
    const byId = new Map(current.providers.map((p) => [p.id, p]));
    const ids = new Set<string>();
    next.providers = body.providers.map((p) => {
      validateProvider(p);
      const prev = p.id ? byId.get(p.id) : undefined;
      const id = prev?.id ?? crypto.randomUUID();
      if (ids.has(id)) throw validation('Duplicate provider id.');
      ids.add(id);
      // A stored key only carries over to the SAME endpoint — re-pointing a provider at another
      // host requires re-entering the key, so it can never be redirected to an arbitrary URL.
      let apiKeyEnc = prev && sameEndpoint(prev, p) ? prev.apiKeyEnc ?? null : null;
      if (p.clearApiKey) apiKeyEnc = null;
      if (p.apiKey !== undefined && p.apiKey.trim() !== '') apiKeyEnc = encryptSecret(p.apiKey.trim(), ctx.companyId);
      if (p.kind === 'anthropic' && !apiKeyEnc && p.enabled) {
        throw validation(`${p.label}: an Anthropic API key is required.`);
      }
      return {
        id,
        kind: p.kind as StoredProviderConfig['kind'],
        label: p.label,
        baseUrl: p.baseUrl || null,
        model: p.model || (p.kind === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : ''),
        apiKeyEnc,
        enabled: p.enabled,
        timeoutMs: p.timeoutMs ?? null,
      };
    });
  }
  if (body.taskPolicies) next.taskPolicies = normalizePolicies({ ...current.taskPolicies, ...body.taskPolicies });
  if (body.cloudEnabled !== undefined) next.cloudEnabled = body.cloudEnabled;
  if (body.autoApplyEnabled !== undefined) next.autoApplyEnabled = body.autoApplyEnabled;
  if (body.autoApplyThreshold !== undefined) next.autoApplyThreshold = body.autoApplyThreshold.toFixed(4);
  if (body.llmSuggestEnabled !== undefined) next.llmSuggestEnabled = body.llmSuggestEnabled;

  const auditView = (s: SettingsRecord) => ({
    providers: s.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled, hasApiKey: !!p.apiKeyEnc })),
    taskPolicies: s.taskPolicies,
    cloudEnabled: s.cloudEnabled,
    autoApplyEnabled: s.autoApplyEnabled,
    autoApplyThreshold: s.autoApplyThreshold,
    llmSuggestEnabled: s.llmSuggestEnabled,
  });

  await inTransaction(ctx, async (tx) => {
    const values = {
      providers: next.providers as unknown as Record<string, unknown>[],
      taskPolicies: next.taskPolicies as Record<string, string>,
      cloudEnabled: next.cloudEnabled,
      autoApplyEnabled: next.autoApplyEnabled,
      autoApplyThreshold: next.autoApplyThreshold,
      llmSuggestEnabled: next.llmSuggestEnabled,
      updatedAt: new Date(),
    };
    const [existing] = await tx.db.select({ id: aiSettings.id }).from(aiSettings).where(eq(aiSettings.companyId, tx.companyId));
    if (existing) {
      await tx.db.update(aiSettings).set(values).where(eq(aiSettings.id, existing.id));
    } else {
      await tx.db.insert(aiSettings).values({ companyId: tx.companyId, ...values });
    }
    await writeAudit(tx, {
      action: 'update',
      entityType: 'ai_settings',
      entityId: tx.companyId,
      oldValues: auditView(current), // never includes key material
      newValues: auditView(next),
    });
  });
  return getPublicSettings(ctx);
}

// ---------------------------------------------------------------------------
// Runtime: providers, redactor, router
// ---------------------------------------------------------------------------

function runtimeConfig(p: StoredProviderConfig, companyId: string): ProviderRuntimeConfig {
  const { apiKeyEnc, ...rest } = p;
  return { ...rest, apiKey: apiKeyEnc ? decryptSecret(apiKeyEnc, companyId) : null };
}

/** Instantiate the enabled providers (skipping ones whose config cannot be used). */
export function buildProviders(
  stored: StoredProviderConfig[],
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  deps: ProviderDeps = {},
): AiProvider[] {
  const out: AiProvider[] = [];
  // Every provider call is checked against this company's network policy (purpose 'ai').
  const withPolicy: ProviderDeps = { ...deps, policyCtx: { db: ctx.db, companyId: ctx.companyId } };
  for (const p of stored) {
    if (!p.enabled) continue;
    try {
      out.push(createProvider(runtimeConfig(p, ctx.companyId), withPolicy));
    } catch (err) {
      console.warn(`[ai] provider ${p.label} skipped:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/**
 * Company-aware redactor: customer / vendor / employee names, their emails, phones, street
 * addresses and tax ids. Built lazily — only when a cloud call actually happens.
 */
export async function buildCompanyRedactor(ctx: ServiceContext): Promise<Redactor> {
  const [custs, vends, emps] = await Promise.all([
    ctx.db.select({
      displayName: customers.displayName, companyName: customers.companyName, email: customers.email,
      phone: customers.phone, billingAddress: customers.billingAddress, shippingAddress: customers.shippingAddress,
    }).from(customers).where(eq(customers.companyId, ctx.companyId)),
    ctx.db.select({
      displayName: vendors.displayName, companyName: vendors.companyName, email: vendors.email,
      phone: vendors.phone, address: vendors.address, taxId: vendors.taxId,
    }).from(vendors).where(eq(vendors.companyId, ctx.companyId)),
    ctx.db.select({
      firstName: employees.firstName, lastName: employees.lastName, email: employees.email,
      address: employees.address, ssn: employees.ssn,
    }).from(employees).where(eq(employees.companyId, ctx.companyId)),
  ]);
  const ents: KnownEntity[] = [];
  const push = (text: string | null | undefined, kind: KnownEntity['kind']) => {
    if (text && text.trim()) ents.push({ text: text.trim(), kind });
  };
  for (const c of custs) {
    push(c.displayName, 'CUSTOMER');
    push(c.companyName, 'CUSTOMER');
    push(c.email, 'EMAIL');
    push(c.phone, 'PHONE');
    ents.push(...addressEntities(c.billingAddress), ...addressEntities(c.shippingAddress));
  }
  for (const v of vends) {
    push(v.displayName, 'VENDOR');
    push(v.companyName, 'VENDOR');
    push(v.email, 'EMAIL');
    push(v.phone, 'PHONE');
    push(v.taxId, 'TAXID');
    ents.push(...addressEntities(v.address));
  }
  for (const e of emps) {
    push(`${e.firstName} ${e.lastName}`, 'EMPLOYEE');
    push(`${e.lastName}, ${e.firstName}`, 'EMPLOYEE');
    push(e.email, 'EMAIL');
    push(e.ssn, 'SSN');
    ents.push(...addressEntities(e.address));
  }
  return new Redactor(ents);
}

export interface BuildRouterOptions {
  deps?: ProviderDeps;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

/** The live router for this company. Cheap to build; build one per request. */
export async function buildRouter(ctx: ServiceContext, opts: BuildRouterOptions = {}): Promise<AiRouter> {
  const s = await loadSettings(ctx);
  const providers = buildProviders(s.providers, ctx, opts.deps);
  let redactor: Promise<Redactor> | null = null;
  return new AiRouter({
    providers,
    cloudEnabled: s.cloudEnabled,
    taskPolicies: s.taskPolicies,
    providerTimeouts: Object.fromEntries(s.providers.map((p) => [p.id, p.timeoutMs ?? undefined])),
    redactorFactory: () => (redactor ??= buildCompanyRedactor(ctx)),
    retries: opts.retries,
    sleep: opts.sleep,
  });
}

// ---------------------------------------------------------------------------
// Test connection / model picker
// ---------------------------------------------------------------------------

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  models: ModelInfo[];
  locality: 'local' | 'cloud';
  hostClass: string | null;
  warning: string | null;
}

/**
 * Probe a provider — either a saved one (by id) or an unsaved draft from the form. A draft
 * without an apiKey reuses the saved key of the provider with the same id.
 */
function normUrl(u: string | null | undefined): string {
  return (u ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/** True when a draft provider still points at the saved provider's kind + base URL. */
function sameEndpoint(saved: StoredProviderConfig, draft: { kind: string; baseUrl?: string | null }): boolean {
  return saved.kind === draft.kind && normUrl(saved.baseUrl) === normUrl(draft.baseUrl);
}

export async function testConnection(
  ctx: ServiceContext,
  input: ProviderInput,
  deps: ProviderDeps = {},
): Promise<TestConnectionResult> {
  await requireRole(ctx, 'admin');
  const parsed = providerInputSchema.safeParse(input);
  if (!parsed.success) throw validation(parsed.error.issues.map((i) => i.message).join('; '));
  const p = parsed.data;
  const s = await loadSettings(ctx);
  const saved = p.id ? s.providers.find((x) => x.id === p.id) : undefined;
  // Reuse the saved key only for the endpoint it was saved for (see sameEndpoint).
  const apiKey =
    p.apiKey?.trim() ||
    (saved?.apiKeyEnc && sameEndpoint(saved, p) ? decryptSecret(saved.apiKeyEnc, ctx.companyId) : null);
  const cfg: ProviderRuntimeConfig = {
    id: p.id ?? 'draft',
    kind: p.kind as ProviderRuntimeConfig['kind'],
    label: p.label,
    baseUrl: p.baseUrl || null,
    model: p.model || (p.kind === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : ''),
    enabled: true,
    apiKey,
  };
  const ep = p.kind === 'anthropic' && !p.baseUrl ? null : classifyEndpoint(p.baseUrl);
  const base = { locality: localityOf(cfg), hostClass: ep?.hostClass ?? null, warning: ep?.warning ?? null };
  let provider: AiProvider;
  try {
    provider = createProvider(cfg, { ...deps, policyCtx: { db: ctx.db, companyId: ctx.companyId } });
  } catch (err) {
    return { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err), models: [], ...base };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), p.timeoutMs ?? 15_000);
  try {
    const health = await provider.health({ signal: ac.signal });
    if (!health.ok) return { ...health, models: [], ...base };
    let models: ModelInfo[] = [];
    try {
      models = await provider.listModels({ signal: ac.signal });
    } catch {
      /* health passed; model list is best-effort */
    }
    return { ...health, models, ...base };
  } finally {
    clearTimeout(timer);
  }
}
