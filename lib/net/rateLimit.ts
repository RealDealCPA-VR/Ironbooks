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
 * Attempts are admitted with begin() BEFORE the slow password hash and released after it, and
 * an attempt in flight counts against the limit like a failure would — so a burst of parallel
 * guesses can't all slip past the gate before the first failure is recorded.
 *
 * Remote-triggered lockouts never reach this machine: account and global keys are kept apart
 * for local (on the host itself) and network (through the multi-user host) sign-ins, so a
 * tailnet peer guessing the owner's password can't lock the owner out at the host.
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

export interface RateLimitTicket extends RateLimitVerdict {
  /** Call once the attempt has finished (success or failure); idempotent. */
  release(): void;
}

export class LoginRateLimiter {
  private buckets = new Map<string, Bucket>();
  private inflight = new Map<string, number>();
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

  /**
   * Admit one attempt: refused while any key is locked, or while failures in the window plus
   * attempts still in flight would reach the limit. When allowed, the caller MUST release().
   */
  begin(keys: string[], now = Date.now(), weights: Record<string, number> = {}): RateLimitTicket {
    const verdict = this.check(keys, now);
    if (!verdict.allowed) return { ...verdict, release: () => {} };
    for (const k of keys) {
      const max = this.opts.maxFailures * (weights[k] ?? 1);
      const b = this.buckets.get(k);
      const recent = b ? b.failures.filter((t) => now - t < this.opts.windowMs).length : 0;
      if (recent + (this.inflight.get(k) ?? 0) >= max) {
        // Too many guesses already pending: retry once they have resolved.
        return { allowed: false, retryAfterMs: 1000, release: () => {} };
      }
    }
    for (const k of keys) this.inflight.set(k, (this.inflight.get(k) ?? 0) + 1);
    let released = false;
    return {
      allowed: true,
      retryAfterMs: 0,
      release: () => {
        if (released) return;
        released = true;
        for (const k of keys) {
          const n = (this.inflight.get(k) ?? 1) - 1;
          if (n <= 0) this.inflight.delete(k);
          else this.inflight.set(k, n);
        }
      },
    };
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

const RESET_DEFAULTS: RateLimitOptions = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
  maxLockoutMs: 60 * 60 * 1000,
};

const gr = globalThis as unknown as { __bkaResetLimiter?: LoginRateLimiter };

/**
 * Process-wide limiter for the self-service password-reset routes (/api/auth/request-reset and
 * /api/auth/reset). Every reset REQUEST counts against it (not only failures), as does every
 * attempt with a wrong token.
 */
export function resetLimiter(): LoginRateLimiter {
  return (gr.__bkaResetLimiter ??= new LoginRateLimiter(RESET_DEFAULTS));
}

/** Standard 429 response body for the password-reset routes. */
export function tooManyResets(retryAfterMs: number): { body: Record<string, unknown>; retryAfter: string } {
  const r = tooManyAttempts(retryAfterMs);
  const secs = Number(r.retryAfter);
  return {
    body: {
      error: `Too many password-reset attempts. Try again in ${secs < 90 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minutes`}.`,
      code: 'RATE_LIMITED',
    },
    retryAfter: r.retryAfter,
  };
}

/**
 * Keys for one sign-in attempt. `scope` separates login / unlock / portal counters; `addr` is
 * the peer address, or 'local' for this machine. Local sign-ins get their own account and
 * global keys, so failures arriving over the network can never lock out the host itself.
 * The global key is always last (callers weight it with GLOBAL_KEY_WEIGHT).
 */
export function attemptKeys(scope: string, account: string | null, addr: string): string[] {
  const realm = addr === 'local' ? ':local' : '';
  const keys = [`${scope}:addr:${addr}`, `${scope}:global${realm}`];
  if (account) keys.unshift(`${scope}:acct${realm}:${account.trim().toLowerCase()}`);
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
