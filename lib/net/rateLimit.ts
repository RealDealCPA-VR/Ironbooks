/**
 * Sign-in rate limiting (multi-user hosting exposes the login form to the tailnet or the office
 * network).
 *
 * Failures are counted per key within a sliding window; once a key reaches `maxFailures` it is
 * locked out for `lockoutMs`, doubling with each repeat lockout (capped at `maxLockoutMs`).
 * Callers pass several keys per attempt (attemptKeys) and an attempt is refused if ANY key says
 * no. Two realms, kept apart so one can never lock out the other:
 *
 *  - On this computer, in the app itself ('local'): the account, the address and a global key,
 *    all locking, as before. Nothing arriving over the network, and no other program on this
 *    computer, ever counts here.
 *  - Over the network, and programs on this computer outside the app (lib/net/requestInfo.ts):
 *     - the account FROM this address ("device") and the address itself lock, as above — so a
 *       device guessing a teammate's password locks only itself out of that account;
 *     - the account from every address, and everything overall, are THROTTLES: past a burst they
 *       let one more failure through per interval and never ask for a longer wait than that
 *       interval. They bound guessing by someone with many addresses without letting anyone lock
 *       a teammate (or everyone) out for an hour;
 *     - a device that has signed in to an account successfully skips both throttles for that
 *       account (it keeps its own lock), so a teammate at their usual computer is never slowed by
 *       someone else's guessing.
 *
 * Attempts are admitted with begin() BEFORE the slow password hash and released after it, and
 * an attempt in flight counts against the limit like a failure would — so a burst of parallel
 * guesses can't all slip past the gate before the first failure is recorded.
 *
 * In-memory by design: the host server is a single process, and a restart clearing the
 * counters is acceptable (it does not reset faster than a lockout would). The one secret that is
 * short enough for that to matter, the "I forgot my password" challenge answer, is also counted
 * in the company file with lockouts that survive a restart (lib/services/challengeLockout.ts);
 * this limiter stays its first line.
 */

export interface ThrottleOptions {
  /** Failures let through at full speed before the throttle starts. */
  burst: number;
  /** After that, one more failure per this many ms; also the longest wait the throttle asks for. */
  intervalMs: number;
}

export interface RateLimitOptions {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  maxLockoutMs: number;
  /** Network sign-ins: one account, every address (a throttle, never a lock). */
  accountThrottle?: ThrottleOptions;
  /** Network sign-ins: every account and address (a throttle, never a lock). */
  globalThrottle?: ThrottleOptions;
  /** How long a device that signed in to an account skips the two throttles for it. */
  trustedDeviceMs?: number;
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

/** A throttle's fill level (in failures), draining by one every intervalMs since `at`. */
interface ThrottleState {
  level: number;
  at: number;
}

export interface RateLimitTicket extends RateLimitVerdict {
  /** Call once the attempt has finished (success or failure); idempotent. */
  release(): void;
}

/** The global key tolerates this many times more failures than an account/address key. */
export const GLOBAL_KEY_WEIGHT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

type KeyKind = 'device' | 'account-throttle' | 'global-throttle' | 'lock';

/** What a key made by attemptKeys is; any other key is an ordinary locking key. */
function keyKind(key: string): KeyKind {
  const m = /^[^:]*:(acct-at|acct-slow|global-slow)(?::|$)/.exec(key);
  if (!m) return 'lock';
  return m[1] === 'acct-at' ? 'device' : m[1] === 'acct-slow' ? 'account-throttle' : 'global-throttle';
}

export class LoginRateLimiter {
  private buckets = new Map<string, Bucket>();
  private throttles = new Map<string, ThrottleState>();
  /** Device keys (account + address) that signed in successfully, and until when that counts. */
  private trusted = new Map<string, number>();
  private inflight = new Map<string, number>();
  private readonly accountThrottle: ThrottleOptions;
  private readonly globalThrottle: ThrottleOptions;
  private readonly trustedDeviceMs: number;

  constructor(private opts: RateLimitOptions) {
    this.accountThrottle = opts.accountThrottle ?? { burst: opts.maxFailures * 6, intervalMs: 5 * 60 * 1000 };
    this.globalThrottle = opts.globalThrottle ?? { burst: opts.maxFailures * GLOBAL_KEY_WEIGHT, intervalMs: 60 * 1000 };
    this.trustedDeviceMs = opts.trustedDeviceMs ?? 30 * DAY_MS;
  }

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { failures: [], lockedUntil: 0, lockouts: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  private throttleOf(key: string): ThrottleOptions | null {
    const kind = keyKind(key);
    return kind === 'account-throttle' ? this.accountThrottle : kind === 'global-throttle' ? this.globalThrottle : null;
  }

  private level(key: string, t: ThrottleOptions, now: number): number {
    const s = this.throttles.get(key);
    if (!s) return 0;
    return Math.max(0, s.level - Math.max(0, now - s.at) / t.intervalMs);
  }

  /** Does this attempt come from a device that signed in to the account successfully? */
  private fromTrustedDevice(keys: string[], now: number): boolean {
    for (const k of keys) {
      if (keyKind(k) !== 'device') continue;
      const until = this.trusted.get(k);
      if (until !== undefined && until > now) return true;
    }
    return false;
  }

  /** May an attempt proceed for all of these keys? */
  check(keys: string[], now = Date.now()): RateLimitVerdict {
    const trusted = this.fromTrustedDevice(keys, now);
    let wait = 0;
    for (const k of keys) {
      const t = this.throttleOf(k);
      if (t) {
        if (trusted) continue;
        const over = this.level(k, t, now) - (t.burst - 1);
        if (over > 0) wait = Math.max(wait, Math.ceil(over * t.intervalMs));
        continue;
      }
      const b = this.buckets.get(k);
      if (b && b.lockedUntil > now) wait = Math.max(wait, b.lockedUntil - now);
    }
    return { allowed: wait === 0, retryAfterMs: wait };
  }

  /**
   * Admit one attempt: refused while any key is locked or throttled, or while failures in the
   * window plus attempts still in flight would reach the limit. When allowed, the caller MUST
   * release().
   */
  begin(keys: string[], now = Date.now(), weights: Record<string, number> = {}): RateLimitTicket {
    const verdict = this.check(keys, now);
    if (!verdict.allowed) return { ...verdict, release: () => {} };
    const trusted = this.fromTrustedDevice(keys, now);
    for (const k of keys) {
      const pending = this.inflight.get(k) ?? 0;
      const t = this.throttleOf(k);
      if (t) {
        if (!trusted && this.level(k, t, now) + pending + 1 > t.burst) {
          return { allowed: false, retryAfterMs: 1000, release: () => {} };
        }
        continue;
      }
      const max = this.opts.maxFailures * (weights[k] ?? 1);
      const b = this.buckets.get(k);
      const recent = b ? b.failures.filter((f) => now - f < this.opts.windowMs).length : 0;
      if (recent + pending >= max) {
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

  /**
   * Record a failed attempt against every key; returns the verdict for the NEXT attempt. A
   * throttle key fills by one (weights do not apply to it: its burst is its own).
   */
  recordFailure(keys: string[], now = Date.now(), weights: Record<string, number> = {}): RateLimitVerdict {
    for (const k of keys) {
      const t = this.throttleOf(k);
      if (t) {
        this.throttles.set(k, { level: this.level(k, t, now) + 1, at: now });
        continue;
      }
      const b = this.bucket(k);
      const max = this.opts.maxFailures * (weights[k] ?? 1);
      b.failures = b.failures.filter((f) => now - f < this.opts.windowMs);
      b.failures.push(now);
      if (b.failures.length >= max) {
        const lock = Math.min(this.opts.lockoutMs * 2 ** b.lockouts, this.opts.maxLockoutMs);
        b.lockedUntil = now + lock;
        b.lockouts += 1;
        b.failures = [];
        // A device that keeps getting it wrong no longer skips the shared throttles.
        if (keyKind(k) === 'device') this.trusted.delete(k);
      }
    }
    this.prune(now);
    return this.check(keys, now);
  }

  /**
   * A successful sign-in clears the account/address counters (not the global one, nor the
   * shared network throttles) and lets that device skip the throttles for that account.
   */
  recordSuccess(keys: string[], now = Date.now()): void {
    for (const k of keys) {
      if (this.throttleOf(k)) continue;
      this.buckets.delete(k);
      if (keyKind(k) === 'device') this.trusted.set(k, now + this.trustedDeviceMs);
    }
  }

  private prune(now: number): void {
    if (this.buckets.size >= 5000) {
      for (const [k, b] of this.buckets) {
        if (b.lockedUntil <= now && b.failures.every((f) => now - f >= this.opts.windowMs)) {
          this.buckets.delete(k);
        }
      }
    }
    if (this.throttles.size >= 5000) {
      for (const k of this.throttles.keys()) {
        const t = this.throttleOf(k);
        if (!t || this.level(k, t, now) <= 0) this.throttles.delete(k);
      }
    }
    if (this.trusted.size >= 5000) {
      for (const [k, until] of this.trusted) if (until <= now) this.trusted.delete(k);
    }
  }
}

/**
 * Sign-in limits. Locks (this computer's app; one device on the network): 5 wrong in 15 minutes,
 * then 1 minute, doubling to an hour — about 140 guesses a day at most.
 * Network throttles:
 *  - one account from every address: 30 wrong (six devices' worth at once), then one more every
 *    5 minutes (12 an hour, a little over 300 a day however many addresses are used). One device
 *    on its own can never fill it: its lockouts hold it to about 24 at the worst point;
 *  - everything overall: 50 wrong (as the old global lock), then one a minute.
 * Neither asks anyone to wait longer than its interval, and neither applies to a device that has
 * signed in to that account in the last 30 days (since this computer started the app).
 */
const DEFAULTS: RateLimitOptions = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 60 * 1000,
  maxLockoutMs: 60 * 60 * 1000,
  accountThrottle: { burst: 30, intervalMs: 5 * 60 * 1000 },
  globalThrottle: { burst: 50, intervalMs: 60 * 1000 },
  trustedDeviceMs: 30 * DAY_MS,
};

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
  accountThrottle: { burst: 30, intervalMs: 5 * 60 * 1000 },
  globalThrottle: { burst: 50, intervalMs: 60 * 1000 },
  trustedDeviceMs: 30 * DAY_MS,
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
 * the peer address, or 'local' for the app on this computer. The global key (or throttle) is
 * always last (callers weight it with GLOBAL_KEY_WEIGHT; a throttle ignores the weight).
 *
 *  - 'local': account, address and global keys of its own realm, all locking — failures arriving
 *    over the network, or from another program on this computer, can never lock out the host.
 *  - anything else (a teammate's device, or 'this computer, outside Ironbooks'):
 *    [account from this address (lock), address (lock), account from anywhere (throttle),
 *     everything (throttle)] — see the top of this file.
 */
export function attemptKeys(scope: string, account: string | null, addr: string): string[] {
  const acct = account ? account.trim().toLowerCase() : null;
  if (addr === 'local') {
    const keys = [`${scope}:addr:local`, `${scope}:global:local`];
    if (acct) keys.unshift(`${scope}:acct:local:${acct}`);
    return keys;
  }
  const keys = [`${scope}:addr:${addr}`];
  if (acct) {
    // The address is encoded so no address can be spelled to look like another account's key.
    keys.unshift(`${scope}:acct-at:${encodeURIComponent(addr)}|${acct}`);
    keys.push(`${scope}:acct-slow:${acct}`);
  }
  keys.push(`${scope}:global-slow`);
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
