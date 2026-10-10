/**
 * Sign-in rate limiting (multi-user hosting exposes the login form to the tailnet).
 *
 * Failures are counted per key within a sliding window; once a key reaches `maxFailures` it is
 * locked out for `lockoutMs`, doubling with each repeat lockout (capped at `maxLockoutMs`).
 * Callers pass several keys per attempt — the account (email), the client address, and a
 * global key — and an attempt is refused if ANY key is locked. The account key is what stops
 * password guessing even when the attacker rotates addresses; the global key caps password
 * spraying across many accounts.
 *
 * In-memory by design: the host server is a single process, and a restart clearing the
 * counters is acceptable (it does not reset faster than a lockout would).
 */

export interface RateLimitOptions {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  maxLockoutMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Milliseconds until the attempt may be retried (0 when allowed). */
  retryAfterMs: number;
}

interface Bucket {
  failures: number[];
  lockedUntil: number;
  lockouts: number;
}

export class LoginRateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private opts: RateLimitOptions) {}

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { failures: [], lockedUntil: 0, lockouts: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** May an attempt proceed for all of these keys? */
  check(keys: string[], now = Date.now()): RateLimitVerdict {
    let wait = 0;
    for (const k of keys) {
      const b = this.buckets.get(k);
      if (b && b.lockedUntil > now) wait = Math.max(wait, b.lockedUntil - now);
    }
    return { allowed: wait === 0, retryAfterMs: wait };
  }

  /** Record a failed attempt against every key; returns the verdict for the NEXT attempt. */
  recordFailure(keys: string[], now = Date.now(), weights: Record<string, number> = {}): RateLimitVerdict {
    for (const k of keys) {
      const b = this.bucket(k);
      const max = this.opts.maxFailures * (weights[k] ?? 1);
      b.failures = b.failures.filter((t) => now - t < this.opts.windowMs);
      b.failures.push(now);
      if (b.failures.length >= max) {
        const lock = Math.min(this.opts.lockoutMs * 2 ** b.lockouts, this.opts.maxLockoutMs);
        b.lockedUntil = now + lock;
        b.lockouts += 1;
        b.failures = [];
      }
    }
    this.prune(now);
    return this.check(keys, now);
  }

  /** A successful sign-in clears the account/address counters (not the global one). */
  recordSuccess(keys: string[]): void {
    for (const k of keys) this.buckets.delete(k);
  }

  private prune(now: number): void {
    if (this.buckets.size < 5000) return;
    for (const [k, b] of this.buckets) {
      if (b.lockedUntil <= now && b.failures.every((t) => now - t >= this.opts.windowMs)) {
        this.buckets.delete(k);
      }
    }
  }
}

const DEFAULTS: RateLimitOptions = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 60 * 1000,
  maxLockoutMs: 60 * 60 * 1000,
};

/** The global key tolerates this many times more failures than an account/address key. */
export const GLOBAL_KEY_WEIGHT = 10;

const g = globalThis as unknown as { __bkaLoginLimiter?: LoginRateLimiter };

/** Process-wide limiter shared by the login, unlock and portal-login routes. */
export function loginLimiter(): LoginRateLimiter {
  return (g.__bkaLoginLimiter ??= new LoginRateLimiter(DEFAULTS));
}

/** Keys for one sign-in attempt. `scope` separates login / unlock / portal counters. */
export function attemptKeys(scope: string, account: string | null, addr: string): string[] {
  const keys = [`${scope}:addr:${addr}`, `${scope}:global`];
  if (account) keys.unshift(`${scope}:acct:${account.trim().toLowerCase()}`);
  return keys;
}

/** Standard 429 body + Retry-After seconds. */
export function tooManyAttempts(retryAfterMs: number): { body: Record<string, unknown>; retryAfter: string } {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const mins = Math.ceil(secs / 60);
  return {
    body: {
      error: `Too many failed sign-in attempts. Try again in ${secs < 90 ? `${secs} seconds` : `${mins} minutes`}.`,
      code: 'RATE_LIMITED',
    },
    retryAfter: String(secs),
  };
}
