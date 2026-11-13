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
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiSettings, bankAccounts, companies, customers, employees, jobs, leads, otherNames, salesReps, vendors } from '@/lib/db/schema';
import { type ServiceContext, validation, writeAudit, inTransaction } from './_base';
import { requireRole } from './rbac';
import { AiRouter } from '@/lib/ai/router';
import { createProvider, localityOf, type ProviderDeps, pullOllamaModel } from '@/lib/ai/providers';
import { classifyEndpoint } from '@/lib/ai/tailnet';
import { verifyTailnetUrls } from '@/lib/net/tailnetVerify';
import { isLegacyBlob, migrateLegacySecrets, openStoredSecret, readVaultSecret, sealForFile } from '@/lib/ai/keyVault';
import { Redactor, addressEntities, type KnownEntity } from '@/lib/ai/redact';
import { parseCredentials } from '@/lib/ai/chatgpt';
import {
  AI_TASKS,
  AiError,
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
  /** Cloud AI calls allowed per day for this company (0 = no limit). A spend guard. */
  cloudDailyCap: number;
  /** Cloud AI calls made today (UTC day). */
  cloudCallsToday: number;
  autoApplyEnabled: boolean;
  /** 0..1 as a decimal string, e.g. "0.9500". */
  autoApplyThreshold: string;
  llmSuggestEnabled: boolean;
}

interface SettingsRecord {
  providers: StoredProviderConfig[];
  taskPolicies: Record<AiTask, RoutingPolicy>;
  cloudEnabled: boolean;
  cloudDailyCap: number;
  autoApplyEnabled: boolean;
  autoApplyThreshold: string;
  llmSuggestEnabled: boolean;
}

/** Default daily cloud-call limit: generous for a small business, a hard stop for a runaway loop. */
export const DEFAULT_CLOUD_DAILY_CAP = 500;

const DEFAULTS: SettingsRecord = {
  providers: [],
  taskPolicies: { categorize: DEFAULT_POLICY, assistant: DEFAULT_POLICY, 'error-correction': DEFAULT_POLICY },
  cloudEnabled: false,
  cloudDailyCap: DEFAULT_CLOUD_DAILY_CAP,
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

/**
 * The company file's vault secret each loaded provider's key is opened with (lib/ai/keyVault.ts).
 * Keyed by the provider objects loadSettings returns, so the synchronous buildProviders can open
 * their keys without another database round trip — and nothing secret is added to the objects.
 */
const vaultSecretOf = new WeakMap<object, string | null>();

/** The plaintext key of a stored provider, or null (none, or unreadable on this computer). */
function openKey(p: StoredProviderConfig, companyId: string): string | null {
  if (!p.apiKeyEnc) return null;
  return openStoredSecret(p.apiKeyEnc, companyId, vaultSecretOf.get(p) ?? null);
}

/**
 * Load the raw settings record (defaults when the company has none yet). It only writes to move
 * keys saved by an older version (encrypted with this computer's own key, which never travels
 * with the company file) to the company file's key — lib/ai/keyVault.ts migrateLegacySecrets.
 */
// The daily cap and today's count live in companies.settings (no schema change): keys
// `aiCloudCap` (number) and `aiCloudUsage` ({ day: 'YYYY-MM-DD', calls }), merged one key at a time.
const CAP_KEY = 'aiCloudCap';
const USAGE_KEY = 'aiCloudUsage';

async function readCompanyAiSettings(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<{ cap: number; usage: { day: string; calls: number } }> {
  const [row] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  const s = (row?.settings ?? {}) as Record<string, unknown>;
  const capRaw = s[CAP_KEY];
  const cap = typeof capRaw === 'number' && Number.isInteger(capRaw) && capRaw >= 0 ? capRaw : DEFAULT_CLOUD_DAILY_CAP;
  const u = s[USAGE_KEY] as { day?: unknown; calls?: unknown } | undefined;
  const usage = u && typeof u.day === 'string' && typeof u.calls === 'number' ? { day: u.day, calls: u.calls } : { day: '', calls: 0 };
  return { cap, usage };
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Today's cloud-call count (0 when none today). */
export async function cloudCallsToday(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<number> {
  const { usage } = await readCompanyAiSettings(ctx);
  return usage.day === utcDay() ? usage.calls : 0;
}

/**
 * Before each cloud AI call: refuse when the company's daily limit is reached, else count it.
 * The count is one merged key in companies.settings, so it survives restarts and travels with
 * the company file; a limit of 0 means no limit.
 */
export async function noteCloudCall(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<void> {
  const { cap, usage } = await readCompanyAiSettings(ctx);
  const day = utcDay();
  const calls = usage.day === day ? usage.calls : 0;
  if (cap > 0 && calls >= cap) {
    throw new AiError(
      'POLICY',
      `This company's daily limit of ${cap} cloud AI calls is reached. Raise or remove the limit under AI & Automation, or wait until tomorrow (UTC).`,
    );
  }
  await ctx.db
    .update(companies)
    .set({
      settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object(${USAGE_KEY}::text, ${JSON.stringify({ day, calls: calls + 1 })}::jsonb)`,
    })
    .where(eq(companies.id, ctx.companyId));
}

export async function loadSettings(ctx: ServiceContext): Promise<SettingsRecord> {
  const { cap } = await readCompanyAiSettings(ctx);
  let [row] = await ctx.db.select().from(aiSettings).where(eq(aiSettings.companyId, ctx.companyId));
  if (!row) return { ...DEFAULTS, taskPolicies: { ...DEFAULTS.taskPolicies }, cloudDailyCap: cap };
  const stored = (row.providers as unknown as StoredProviderConfig[]) ?? [];
  if (
    stored.some((p) => isLegacyBlob(p?.apiKeyEnc)) &&
    (await migrateLegacySecrets(ctx.db, { companyId: ctx.companyId })) > 0
  ) {
    [row] = await ctx.db.select().from(aiSettings).where(eq(aiSettings.companyId, ctx.companyId));
  }
  const providers = (row.providers as unknown as StoredProviderConfig[]) ?? [];
  const fileSecret = providers.some((p) => p?.apiKeyEnc) ? await readVaultSecret(ctx.db) : null;
  for (const p of providers) if (p && typeof p === 'object') vaultSecretOf.set(p, fileSecret);
  // *.ts.net endpoints count as tailnet (local, unredacted) only when they resolve to tailnet
  // addresses — Funnel names are public (lib/net/tailnetVerify.ts).
  await verifyTailnetUrls(providers.map((p) => p.baseUrl));
  return {
    providers,
    taskPolicies: normalizePolicies(row.taskPolicies),
    cloudEnabled: row.cloudEnabled,
    cloudDailyCap: cap,
    autoApplyEnabled: row.autoApplyEnabled,
    autoApplyThreshold: row.autoApplyThreshold,
    llmSuggestEnabled: row.llmSuggestEnabled,
  };
}

/** Providers with no server address of their own: Anthropic's default endpoint, the ChatGPT plan. */
function noEndpoint(p: { kind: string; baseUrl?: string | null }): boolean {
  return p.kind === 'chatgpt' || (p.kind === 'anthropic' && !p.baseUrl);
}

function toPublic(p: StoredProviderConfig, companyId: string): PublicProviderConfig {
  const { apiKeyEnc, ...rest } = p;
  const ep = noEndpoint(p) ? null : classifyEndpoint(p.baseUrl);
  const plain = apiKeyEnc ? openKey(p, companyId) : null;
  const unreadable = !!apiKeyEnc && plain === null;
  return {
    ...rest,
    hasApiKey: !!apiKeyEnc && !unreadable,
    ...(unreadable ? { apiKeyUnreadable: true } : {}),
    locality: localityOf(p),
    hostClass: ep?.hostClass ?? null,
    warning: ep?.warning ?? null,
    ...(p.kind === 'chatgpt' ? { account: parseCredentials(plain)?.email ?? null } : {}),
  };
}

/** Settings as the client may see them — key material stripped. */
export async function getPublicSettings(ctx: ServiceContext): Promise<AiSettingsView> {
  const s = await loadSettings(ctx);
  return {
    providers: s.providers.map((p) => toPublic(p, ctx.companyId)),
    taskPolicies: s.taskPolicies,
    cloudEnabled: s.cloudEnabled,
    cloudDailyCap: s.cloudDailyCap,
    cloudCallsToday: await cloudCallsToday(ctx),
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
  /** Cloud AI calls per day, 0 = no limit. */
  cloudDailyCap: z.number().int().min(0).max(1_000_000).optional(),
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
  if (p.kind === 'chatgpt') {
    // Credentials only ever come from "Continue with ChatGPT" (lib/services/chatgptSignIn.ts).
    if (p.apiKey && p.apiKey.trim()) throw validation(`${p.label}: use "Continue with ChatGPT" to connect your plan.`);
    if (p.baseUrl) throw validation(`${p.label}: a ChatGPT plan connection has no server address.`);
  } else if (p.kind !== 'anthropic') {
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
  /** New plaintext keys by provider id, sealed inside the transaction below. */
  const newKeys = new Map<string, string>();

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
      if (p.apiKey !== undefined && p.apiKey.trim() !== '') {
        newKeys.set(id, p.apiKey.trim());
        apiKeyEnc = null; // sealed below with the company file's own key
      }
      if (p.kind === 'chatgpt' && !apiKeyEnc && p.enabled) {
        throw validation(`${p.label}: click "Continue with ChatGPT" to sign in first.`);
      }
      if (p.kind === 'anthropic' && !apiKeyEnc && !newKeys.has(id) && p.enabled) {
        throw validation(`${p.label}: an Anthropic API key is required.`);
      }
      if (p.kind === 'openai-compatible' && p.enabled && !apiKeyEnc && !newKeys.has(id) && localityOf({ kind: 'openai-compatible', baseUrl: p.baseUrl ?? null }) === 'cloud') {
        throw validation(`${p.label}: paste the API key from your account (cloud AI services need one).`);
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
  if (body.cloudDailyCap !== undefined) next.cloudDailyCap = body.cloudDailyCap;
  if (body.autoApplyEnabled !== undefined) next.autoApplyEnabled = body.autoApplyEnabled;
  if (body.autoApplyThreshold !== undefined) next.autoApplyThreshold = body.autoApplyThreshold.toFixed(4);
  if (body.llmSuggestEnabled !== undefined) next.llmSuggestEnabled = body.llmSuggestEnabled;

  const auditView = (s: SettingsRecord) => ({
    providers: s.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled, hasApiKey: !!p.apiKeyEnc })),
    taskPolicies: s.taskPolicies,
    cloudEnabled: s.cloudEnabled,
    cloudDailyCap: s.cloudDailyCap,
    autoApplyEnabled: s.autoApplyEnabled,
    autoApplyThreshold: s.autoApplyThreshold,
    llmSuggestEnabled: s.llmSuggestEnabled,
  });

  await inTransaction(ctx, async (tx) => {
    // New keys are sealed with the company FILE's own key (lib/ai/keyVault.ts), so they still
    // work when the file is opened on another computer.
    if (newKeys.size) {
      const sealed: StoredProviderConfig[] = [];
      for (const p of next.providers) {
        const plain = newKeys.get(p.id);
        sealed.push(plain === undefined ? p : { ...p, apiKeyEnc: await sealForFile(tx.db, plain, tx.companyId) });
      }
      next.providers = sealed;
    }
    const values = {
      providers: next.providers as unknown as Record<string, unknown>[],
      taskPolicies: next.taskPolicies as Record<string, string>,
      cloudEnabled: next.cloudEnabled,
      autoApplyEnabled: next.autoApplyEnabled,
      autoApplyThreshold: next.autoApplyThreshold,
      llmSuggestEnabled: next.llmSuggestEnabled,
      updatedAt: new Date(),
    };
    if (next.cloudDailyCap !== current.cloudDailyCap) {
      await tx.db
        .update(companies)
        .set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object(${CAP_KEY}::text, ${next.cloudDailyCap}::int)` })
        .where(eq(companies.id, tx.companyId));
    }
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKeyEnc, ...rest } = p;
  return { ...rest, apiKey: openKey(p, companyId) };
}

/** Instantiate the enabled providers (skipping ones whose config cannot be used). */
export function buildProviders(
  stored: StoredProviderConfig[],
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  deps: ProviderDeps = {},
): AiProvider[] {
  const out: AiProvider[] = [];
  // Every provider call is checked against this company's network policy (purpose 'ai').
  const withPolicy: ProviderDeps = {
    ...deps,
    policyCtx: { db: ctx.db, companyId: ctx.companyId },
    // A refreshed ChatGPT sign-in is saved back (its refresh token rotates).
    persistChatGpt:
      deps.persistChatGpt ??
      (async (providerId, creds) => (await import('./chatgptSignIn')).persistChatGptCredentials(ctx, providerId, creds)),
  };
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
 * Company-aware redactor: the names of every person and business in the company's name lists —
 * customers (and their ship-to addresses), vendors, employees, Other Names (owners, partners —
 * QuickBooks' list for anyone who is not a customer, vendor or employee), leads and sales reps —
 * with their emails, phones, street addresses, tax ids and account numbers, plus the company's
 * own bank account numbers. Built lazily — only when a cloud call actually happens.
 */
export async function buildCompanyRedactor(ctx: ServiceContext): Promise<Redactor> {
  const [custs, vends, emps, others, leadRows, reps, banks, jobRows] = await Promise.all([
    ctx.db.select({
      displayName: customers.displayName, companyName: customers.companyName, email: customers.email,
      phone: customers.phone, billingAddress: customers.billingAddress, shippingAddress: customers.shippingAddress,
      shipToAddresses: customers.shipToAddresses, resaleNumber: customers.resaleNumber,
    }).from(customers).where(eq(customers.companyId, ctx.companyId)),
    ctx.db.select({
      displayName: vendors.displayName, companyName: vendors.companyName, email: vendors.email,
      phone: vendors.phone, address: vendors.address, taxId: vendors.taxId, accountNumber: vendors.accountNumber,
      printOnCheckAs: vendors.printOnCheckAs,
    }).from(vendors).where(eq(vendors.companyId, ctx.companyId)),
    ctx.db.select({
      firstName: employees.firstName, lastName: employees.lastName, email: employees.email,
      phone: employees.phone, address: employees.address, ssn: employees.ssn,
    }).from(employees).where(eq(employees.companyId, ctx.companyId)),
    ctx.db.select({
      name: otherNames.name, companyName: otherNames.companyName, email: otherNames.email,
      phone: otherNames.phone, address: otherNames.address, accountNumber: otherNames.accountNumber,
    }).from(otherNames).where(eq(otherNames.companyId, ctx.companyId)),
    ctx.db.select({
      name: leads.name, companyName: leads.companyName, email: leads.email, phone: leads.phone,
      address: leads.address, contacts: leads.contacts,
    }).from(leads).where(eq(leads.companyId, ctx.companyId)),
    ctx.db.select({ name: salesReps.name, email: salesReps.email }).from(salesReps).where(eq(salesReps.companyId, ctx.companyId)),
    ctx.db.select({ accountNumber: bankAccounts.accountNumber }).from(bankAccounts).where(eq(bankAccounts.companyId, ctx.companyId)),
    // prefsperms (review 5 leftover): job-costing job names ("Kowalski Kitchen Remodel").
    ctx.db.select({ name: jobs.name }).from(jobs).where(eq(jobs.companyId, ctx.companyId)),
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
    push(c.resaleNumber, 'TAXID'); // prefsperms: the customer's sales tax resale number
    ents.push(...addressEntities(c.billingAddress), ...addressEntities(c.shippingAddress));
    for (const s of Array.isArray(c.shipToAddresses) ? c.shipToAddresses : []) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.name === 'string') push(s.name, 'CUSTOMER');
      ents.push(...addressEntities(s as Record<string, unknown>));
    }
  }
  for (const v of vends) {
    push(v.displayName, 'VENDOR');
    push(v.companyName, 'VENDOR');
    // prefsperms (review 5 leftover): the legal / print-on-check name — for a sole proprietor
    // usually a personal name ("Robert J Smith" for "Smith Plumbing"), and exactly what bank-feed
    // check and ACH descriptions carry.
    push(v.printOnCheckAs, 'VENDOR');
    push(v.email, 'EMAIL');
    push(v.phone, 'PHONE');
    push(v.taxId, 'TAXID');
    push(v.accountNumber, 'ACCOUNT');
    ents.push(...addressEntities(v.address));
  }
  for (const e of emps) {
    push(`${e.firstName} ${e.lastName}`, 'EMPLOYEE');
    push(`${e.lastName}, ${e.firstName}`, 'EMPLOYEE');
    push(e.email, 'EMAIL');
    push(e.phone, 'PHONE');
    push(e.ssn, 'SSN');
    ents.push(...addressEntities(e.address));
  }
  for (const o of others) {
    push(o.name, 'PERSON');
    push(o.companyName, 'PERSON');
    push(o.email, 'EMAIL');
    push(o.phone, 'PHONE');
    push(o.accountNumber, 'ACCOUNT');
    ents.push(...addressEntities(o.address));
  }
  for (const l of leadRows) {
    push(l.name, 'PERSON');
    push(l.companyName, 'PERSON');
    push(l.email, 'EMAIL');
    push(l.phone, 'PHONE');
    ents.push(...addressEntities(l.address));
    for (const c of Array.isArray(l.contacts) ? l.contacts : []) {
      if (!c || typeof c !== 'object') continue;
      push(c.name, 'PERSON');
      push(c.email, 'EMAIL');
      push(c.phone, 'PHONE');
    }
  }
  for (const r of reps) {
    push(r.name, 'PERSON');
    push(r.email, 'EMAIL');
  }
  for (const b of banks) push(b.accountNumber, 'ACCOUNT');
  for (const j of jobRows) push(j.name, 'CUSTOMER');
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
    beforeCloudCall: () => noteCloudCall(ctx),
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

/**
 * What the settings page shows when a test fails: the usual mistakes in plain words (a key that
 * was not accepted, a server that is not running, a wrong URL), with the raw detail after it.
 */
export function friendlyTestError(error: string, kind: string, baseUrl: string | null | undefined): string {
  const raw = error.trim();
  if (/^Blocked by network policy/i.test(raw)) return raw;
  if (/HTTP 401|HTTP 403|invalid[_ ]api[_ ]key|authentication|unauthorized/i.test(raw)) {
    return `The API key was not accepted. Check it (and that it has credit or access) and try again. (${raw})`;
  }
  if (/HTTP 404/i.test(raw)) {
    return `Nothing answered at that address. Check the server URL${kind === 'openai-compatible' ? " — it usually ends in /v1" : ''}. (${raw})`;
  }
  if (/^Could not reach|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(raw)) {
    const host = (() => {
      try {
        return baseUrl ? new URL(baseUrl).host : null;
      } catch {
        return null;
      }
    })();
    const local = host && /^(localhost|127\.0\.0\.1|\[::1\])/i.test(host);
    return local
      ? `Nothing is listening at ${host}. Start ${kind === 'ollama' ? 'Ollama' : 'the local server (LM Studio: turn on its server)'} and test again. (${raw})`
      : `Could not reach ${host ?? 'the server'}. Check the address and your connection. (${raw})`;
  }
  if (/timed out/i.test(raw)) return `No answer in time. The server may be busy or asleep — try again. (${raw})`;
  return raw;
}

/** The model "Download a starter model" pulls into Ollama: small, capable, runs on a laptop. */
export const OLLAMA_STARTER_MODEL = 'llama3.2';

/** Download a model into a local Ollama server (admin; up to 30 minutes for a large model). */
export async function pullStarterModel(ctx: ServiceContext, input: { baseUrl?: string; model?: string }): Promise<{ model: string }> {
  await requireRole(ctx, 'admin');
  const baseUrl = (input.baseUrl ?? 'http://localhost:11434').trim();
  const model = (input.model ?? OLLAMA_STARTER_MODEL).trim();
  if (!/^[a-z0-9][a-z0-9._:/-]{0,100}$/i.test(model)) throw validation('That is not a model name Ollama knows.');
  await verifyTailnetUrls([baseUrl]);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30 * 60 * 1000);
  try {
    await pullOllamaModel({ kind: 'ollama', baseUrl, apiKey: null }, model, { policyCtx: { db: ctx.db, companyId: ctx.companyId } }, ac.signal);
  } finally {
    clearTimeout(timer);
  }
  return { model };
}

export async function testConnection(
  ctx: ServiceContext,
  input: ProviderInput,
  deps: ProviderDeps = {},
  opts: { allowCloud?: boolean } = {},
): Promise<TestConnectionResult> {
  await requireRole(ctx, 'admin');
  const parsed = providerInputSchema.safeParse(input);
  if (!parsed.success) throw validation(parsed.error.issues.map((i) => i.message).join('; '));
  const p = parsed.data;
  const s = await loadSettings(ctx);
  await verifyTailnetUrls([p.baseUrl]);
  const saved = p.id ? s.providers.find((x) => x.id === p.id) : undefined;
  // Reuse the saved key only for the endpoint it was saved for (see sameEndpoint).
  const savedKey = saved?.apiKeyEnc && sameEndpoint(saved, p) ? openKey(saved, ctx.companyId) : null;
  // A ChatGPT plan connection only ever uses its saved sign-in.
  const apiKey = p.kind === 'chatgpt' ? savedKey : p.apiKey?.trim() || savedKey;
  const cfg: ProviderRuntimeConfig = {
    id: p.id ?? 'draft',
    kind: p.kind as ProviderRuntimeConfig['kind'],
    label: p.label,
    baseUrl: p.baseUrl || null,
    model: p.model || (p.kind === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : ''),
    enabled: true,
    apiKey,
  };
  const ep = noEndpoint(p) ? null : classifyEndpoint(p.baseUrl);
  const base = { locality: localityOf(cfg), hostClass: ep?.hostClass ?? null, warning: ep?.warning ?? null };
  // "Allow cloud AI" is ticked on the page: testing a cloud AI is the person's first use of it,
  // so its Privacy & Network permission is given now (the same one switch Save gives), instead of
  // failing the test until Save. Offline mode / a machine limit is reported, never overridden.
  // The permission is only KEPT when the test succeeds: a failed test (wrong key, typo in the
  // address) leaves Privacy & Network as it was.
  let undoCloud: (() => Promise<void>) | null = null;
  if (base.locality === 'cloud' && opts.allowCloud) {
    const { allowCloudPurpose, getNetworkPolicy, setNetworkPolicy } = await import('./networkPolicy');
    const before = await getNetworkPolicy(ctx);
    const r = await allowCloudPurpose(ctx, 'ai');
    if (r.notice) return { ok: false, latencyMs: 0, error: r.notice, models: [], ...base };
    if (r.changed) undoCloud = async () => void (await setNetworkPolicy(ctx, before));
  }
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
    if (!health.ok) {
      if (undoCloud) await undoCloud().catch(() => undefined);
      return { ...health, error: friendlyTestError(health.error ?? 'Failed.', p.kind, p.baseUrl), models: [], ...base };
    }
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
