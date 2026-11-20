/**
 * AI router — picks a provider per task according to the company's routing policy, with
 * per-attempt timeouts, retries, provider fallback, structured-JSON validation (zod) with
 * one repair attempt, and MANDATORY redaction for every cloud call.
 *
 * Policies (per task):
 *   'local-only' (default) → only local providers (loopback / LAN / tailnet).
 *   'local-then-cloud'     → local providers first, then cloud (if the company enabled cloud).
 *   'cloud-only'           → cloud providers only (if the company enabled cloud).
 *
 * Redaction invariant: a 'cloud' provider never sees a message that has not passed through a
 * Redactor. If the caller supplies no company-aware redactor, a pattern-only one is used.
 *
 * Effects outbox (lib/ai/outbound.ts): every call names its purpose, the caller's own
 * (ChatOptions.purpose) or its task's, which the providers hand to the outbox. In an agent's
 * preview the first provider's call is not made and the outbox stops the work there
 * (EffectNotRunInPreview): it is thrown on at once, with no retry, since the real run would contact
 * that one first. The providers the real run would fall back to when that one does not answer are
 * recorded too (previewFallbacks), so the approval card names every computer the run could contact.
 * The daily cloud-call limit is checked in a preview as in the real run (beforeCloudCall), so a
 * preview does not show a cloud call the real run would refuse.
 */
import type { ZodType, ZodTypeDef } from 'zod';
import { currentEffectsMode } from '@/lib/effects';
import { extractJson } from './json';
import { AI_CALL_PURPOSES, AI_TASK_PURPOSES, isNotRunInPreview, outboundCall, purposeOf } from './outbound';
import { Redactor } from './redact';
import {
  AiError,
  DEFAULT_POLICY,
  isRetryable,
  type AiProvider,
  type AiTask,
  type ChatMessage,
  type ChatOptions,
  type Locality,
  type RoutingPolicy,
} from './types';

export interface RouterConfig {
  /** Enabled providers, in preference order. */
  providers: AiProvider[];
  /** Company opt-in for cloud calls; when false, cloud providers are never used. */
  cloudEnabled: boolean;
  taskPolicies?: Partial<Record<AiTask, RoutingPolicy>>;
  /** Builds a company-aware redactor (customer/vendor/employee lists). Called lazily. */
  redactorFactory?: () => Redactor | Promise<Redactor>;
  /** Per-attempt timeouts. */
  localTimeoutMs?: number;
  cloudTimeoutMs?: number;
  /** Per-provider timeout overrides (StoredProviderConfig.timeoutMs). */
  providerTimeouts?: Record<string, number | null | undefined>;
  /** Retries per provider for transient failures (network / 5xx / 429 / timeout). */
  retries?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Runs before every cloud call (the company's daily cloud-call limit, lib/services/aiSettings.ts
   * noteCloudCall). Throwing an AiError skips that provider like any other failure. Also run in an
   * agent's preview, so the preview stops where the real run would: the bridge previews inside a
   * transaction it rolls back, so the call it counts there is not kept.
   */
  beforeCloudCall?: (p: AiProvider) => Promise<void>;
}

export interface Attempt {
  providerId: string;
  locality: Locality;
  ok: boolean;
  error?: string;
}

export interface RoutedChatResult {
  content: string;
  providerId: string;
  model: string;
  locality: Locality;
  redacted: boolean;
  attempts: Attempt[];
}

export interface RoutedJsonResult<T> extends Omit<RoutedChatResult, 'content'> {
  data: T;
  raw: string;
  repaired: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AiRouter {
  constructor(private readonly cfg: RouterConfig) {}

  policyFor(task: AiTask): RoutingPolicy {
    return this.cfg.taskPolicies?.[task] ?? DEFAULT_POLICY;
  }

  /** Providers eligible for a task, in try-order. */
  candidates(task: AiTask): AiProvider[] {
    const policy = this.policyFor(task);
    const local = this.cfg.providers.filter((p) => p.locality === 'local');
    const cloud = this.cfg.cloudEnabled ? this.cfg.providers.filter((p) => p.locality === 'cloud') : [];
    if (policy === 'local-only') return local;
    if (policy === 'cloud-only') return cloud;
    return [...local, ...cloud];
  }

  /** Human explanation of why no provider is eligible (or null when one is). */
  unavailableReason(task: AiTask): string | null {
    if (this.candidates(task).length > 0) return null;
    const policy = this.policyFor(task);
    const hasCloud = this.cfg.providers.some((p) => p.locality === 'cloud');
    if (policy === 'cloud-only' && !this.cfg.cloudEnabled) return 'Cloud AI is turned off for this company.';
    if (policy === 'cloud-only') return 'No cloud AI provider is configured.';
    if (policy === 'local-only' && hasCloud && this.cfg.providers.every((p) => p.locality === 'cloud')) {
      return 'Only cloud providers are configured, but this task is set to local-only.';
    }
    return 'No AI is connected. Sign in with your ChatGPT plan or add a free model on this computer under Company > AI & Automation.';
  }

  isAvailable(task: AiTask): boolean {
    return this.candidates(task).length > 0;
  }

  private timeoutFor(p: AiProvider): number {
    return (
      this.cfg.providerTimeouts?.[p.id] ??
      (p.locality === 'cloud' ? this.cfg.cloudTimeoutMs ?? 60_000 : this.cfg.localTimeoutMs ?? 90_000)
    );
  }

  /** One provider call with timeout + retries. */
  private async callWithRetry(
    p: AiProvider,
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Promise<{ content: string; model: string }> {
    const retries = this.cfg.retries ?? 1;
    const sleep = this.cfg.sleep ?? defaultSleep;
    if (p.locality === 'cloud' && this.cfg.beforeCloudCall) await this.beforeCloudCall(p, this.cfg.beforeCloudCall);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      opts.signal?.addEventListener('abort', onAbort);
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Race against the timer too, so a provider that ignores the abort signal still times out.
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new AiError('TIMEOUT', `${p.id} timed out after ${this.timeoutFor(p)}ms.`));
        }, this.timeoutFor(p));
      });
      try {
        const res = await Promise.race([p.chat(messages, { ...opts, signal: ac.signal }), timedOut]);
        return { content: res.content, model: res.model };
      } catch (err) {
        // An agent's preview: nothing was sent, and trying again would not send it either.
        if (isNotRunInPreview(err)) throw err;
        lastErr =
          ac.signal.aborted && !opts.signal?.aborted
            ? new AiError('TIMEOUT', `${p.id} timed out after ${this.timeoutFor(p)}ms.`)
            : err;
        if (opts.signal?.aborted) break;
        if (!isRetryable(lastErr) || attempt === retries) break;
        await sleep(250 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr;
  }

  /**
   * The daily cloud-call limit, before a cloud call. In an agent's preview it is checked too, so a
   * preview refuses (or moves on to the next provider) exactly where the real run would. Counting
   * the call is harmless there: the bridge previews inside a transaction it rolls back. A preview
   * on a read-only handle cannot count it at all; only the limit's own refusal (an AiError) counts
   * then, and the outbox still stops the call itself.
   */
  private async beforeCloudCall(p: AiProvider, hook: (p: AiProvider) => Promise<void>): Promise<void> {
    try {
      await hook(p);
    } catch (err) {
      if (currentEffectsMode() !== 'capture' || err instanceof AiError) throw err;
    }
  }

  /**
   * In an agent's preview, after the first provider's call was stopped: record a call to each
   * provider the real run would try next if that one did not answer (a local server, then perhaps
   * a cloud one), so the approval card names every computer the run could contact. None is called:
   * the outbox only records in a preview. A computer already named is not named twice.
   */
  private async previewFallbacks(tried: AiProvider, rest: AiProvider[], opts: ChatOptions): Promise<void> {
    if (currentEffectsMode() !== 'capture') return;
    const purpose = purposeOf(opts, AI_CALL_PURPOSES.chat);
    const named = new Set([hostName(tried)]);
    let before = hostName(tried);
    for (const p of rest) {
      const host = hostName(p);
      if (named.has(host)) continue;
      named.add(host);
      try {
        await outboundCall(`${purpose}, if ${before} does not answer`, host, () =>
          Promise.reject(new Error('A preview does not contact other computers.')),
        );
      } catch (err) {
        if (!isNotRunInPreview(err)) throw err;
      }
      before = host;
    }
  }

  private async redactorFor(p: AiProvider): Promise<Redactor | null> {
    if (p.locality !== 'cloud') return null;
    // Cloud calls are ALWAYS redacted — fall back to pattern-only redaction.
    return (await this.cfg.redactorFactory?.()) ?? new Redactor();
  }

  /** Plain chat: returns the first successful provider's text (restored if redacted). */
  async chat(task: AiTask, messages: ChatMessage[], options: ChatOptions = {}): Promise<RoutedChatResult> {
    const providers = this.candidates(task);
    if (providers.length === 0) throw new AiError('UNAVAILABLE', this.unavailableReason(task)!);
    const opts = withPurpose(task, options);
    const attempts: Attempt[] = [];
    for (const [i, p] of providers.entries()) {
      try {
        const redactor = await this.redactorFor(p);
        const wire = redactor ? messages.map((m) => ({ ...m, content: redactor.redact(m.content) })) : messages;
        const res = await this.callWithRetry(p, wire, opts);
        attempts.push({ providerId: p.id, locality: p.locality, ok: true });
        return {
          content: redactor ? redactor.restore(res.content) : res.content,
          providerId: p.id,
          model: res.model,
          locality: p.locality,
          redacted: !!redactor,
          attempts,
        };
      } catch (err) {
        // An agent's preview stops at the first call it would make; the ones after it are only named.
        if (isNotRunInPreview(err)) {
          await this.previewFallbacks(p, providers.slice(i + 1), opts);
          throw err;
        }
        attempts.push({ providerId: p.id, locality: p.locality, ok: false, error: errMsg(err) });
        if (opts.signal?.aborted) break;
      }
    }
    throw new AiError('UNAVAILABLE', `No AI model could answer (${attempts.map((a) => `${a.providerId}: ${a.error}`).join('; ')}).`, attempts);
  }

  /**
   * Structured output: the reply must parse as JSON and satisfy `schema`. On failure the model
   * gets ONE repair turn with the validation errors; if that also fails the next provider is
   * tried. Placeholders are restored inside the parsed value before validation.
   */
  async chatJson<T>(
    task: AiTask,
    messages: ChatMessage[],
    schema: ZodType<T, ZodTypeDef, unknown>,
    options: ChatOptions = {},
  ): Promise<RoutedJsonResult<T>> {
    const providers = this.candidates(task);
    if (providers.length === 0) throw new AiError('UNAVAILABLE', this.unavailableReason(task)!);
    const opts = withPurpose(task, options);
    const attempts: Attempt[] = [];

    for (const [i, p] of providers.entries()) {
      try {
        const redactor = await this.redactorFor(p);
        const wire = redactor ? messages.map((m) => ({ ...m, content: redactor.redact(m.content) })) : messages;
        const first = await this.callWithRetry(p, wire, opts);
        const parsed1 = parseAndValidate(first.content, schema, redactor);
        if (parsed1.ok) {
          attempts.push({ providerId: p.id, locality: p.locality, ok: true });
          return { data: parsed1.data, raw: first.content, repaired: false, providerId: p.id, model: first.model, locality: p.locality, redacted: !!redactor, attempts };
        }
        // One repair attempt. For a cloud provider the error text is built from placeholder
        // values (see parseAndValidate) and is redacted again as defense in depth.
        const repairText =
          `Your previous reply was not valid: ${parsed1.error}. ` +
          'Reply again with ONLY the corrected JSON — no prose, no markdown fences.';
        const repairMsgs: ChatMessage[] = [
          ...wire,
          { role: 'assistant', content: redactor ? redactor.redact(first.content) : first.content },
          { role: 'user', content: redactor ? redactor.redact(repairText) : repairText },
        ];
        const second = await this.callWithRetry(p, repairMsgs, opts);
        const parsed2 = parseAndValidate(second.content, schema, redactor);
        if (parsed2.ok) {
          attempts.push({ providerId: p.id, locality: p.locality, ok: true });
          return { data: parsed2.data, raw: second.content, repaired: true, providerId: p.id, model: second.model, locality: p.locality, redacted: !!redactor, attempts };
        }
        throw new AiError('BAD_OUTPUT', `Invalid structured output after repair: ${parsed2.error}`);
      } catch (err) {
        // An agent's preview stops at the first call it would make; the ones after it are only named.
        if (isNotRunInPreview(err)) {
          await this.previewFallbacks(p, providers.slice(i + 1), opts);
          throw err;
        }
        attempts.push({ providerId: p.id, locality: p.locality, ok: false, error: errMsg(err) });
        if (opts.signal?.aborted) break;
      }
    }
    throw new AiError('UNAVAILABLE', `No AI model returned a valid answer (${attempts.map((a) => `${a.providerId}: ${a.error}`).join('; ')}).`, attempts);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The computer a provider's calls reach, for a preview; its name when it does not say. */
function hostName(p: AiProvider): string {
  return p.host?.trim() || `the AI provider "${p.id}"`;
}

/** The options with a purpose for the effects outbox: the caller's own, else the task's. */
function withPurpose(task: AiTask, opts: ChatOptions): ChatOptions {
  return { ...opts, purpose: purposeOf(opts, AI_TASK_PURPOSES[task]) };
}

function parseAndValidate<T>(
  content: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  redactor: Redactor | null,
): { ok: true; data: T } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = extractJson(content);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const res = schema.safeParse(redactor ? redactor.restoreDeep(value) : value);
  if (res.success) return { ok: true, data: res.data };
  // The error text goes back to the model in the repair turn. For a redacted (cloud) call it
  // is built from the UNRESTORED value, so any quoted "received '…'" is a placeholder and
  // never a real value. If the placeholder form happens to validate, give no details.
  let failure = res.error;
  if (redactor) {
    const raw = schema.safeParse(value);
    if (raw.success) return { ok: false, error: 'the values did not satisfy the required schema' };
    failure = raw.error;
  }
  const issues = failure.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}
