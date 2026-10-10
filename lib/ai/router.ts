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
 */
import type { ZodType, ZodTypeDef } from 'zod';
import { extractJson } from './json';
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
    return 'No AI model is configured. Add a local model in Settings → AI & Automation.';
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

  private async redactorFor(p: AiProvider): Promise<Redactor | null> {
    if (p.locality !== 'cloud') return null;
    // Cloud calls are ALWAYS redacted — fall back to pattern-only redaction.
    return (await this.cfg.redactorFactory?.()) ?? new Redactor();
  }

  /** Plain chat: returns the first successful provider's text (restored if redacted). */
  async chat(task: AiTask, messages: ChatMessage[], opts: ChatOptions = {}): Promise<RoutedChatResult> {
    const providers = this.candidates(task);
    if (providers.length === 0) throw new AiError('UNAVAILABLE', this.unavailableReason(task)!);
    const attempts: Attempt[] = [];
    for (const p of providers) {
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
    opts: ChatOptions = {},
  ): Promise<RoutedJsonResult<T>> {
    const providers = this.candidates(task);
    if (providers.length === 0) throw new AiError('UNAVAILABLE', this.unavailableReason(task)!);
    const attempts: Attempt[] = [];

    for (const p of providers) {
      try {
        const redactor = await this.redactorFor(p);
        const wire = redactor ? messages.map((m) => ({ ...m, content: redactor.redact(m.content) })) : messages;
        const first = await this.callWithRetry(p, wire, opts);
        const parsed1 = parseAndValidate(first.content, schema, redactor);
        if (parsed1.ok) {
          attempts.push({ providerId: p.id, locality: p.locality, ok: true });
          return { data: parsed1.data, raw: first.content, repaired: false, providerId: p.id, model: first.model, locality: p.locality, redacted: !!redactor, attempts };
        }
        // One repair attempt.
        const repairMsgs: ChatMessage[] = [
          ...wire,
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content:
              `Your previous reply was not valid: ${parsed1.error}. ` +
              'Reply again with ONLY the corrected JSON — no prose, no markdown fences.',
          },
        ];
        const second = await this.callWithRetry(p, repairMsgs, opts);
        const parsed2 = parseAndValidate(second.content, schema, redactor);
        if (parsed2.ok) {
          attempts.push({ providerId: p.id, locality: p.locality, ok: true });
          return { data: parsed2.data, raw: second.content, repaired: true, providerId: p.id, model: second.model, locality: p.locality, redacted: !!redactor, attempts };
        }
        throw new AiError('BAD_OUTPUT', `Invalid structured output after repair: ${parsed2.error}`);
      } catch (err) {
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
  if (redactor) value = redactor.restoreDeep(value);
  const res = schema.safeParse(value);
  if (res.success) return { ok: true, data: res.data };
  const issues = res.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}
