import { describe, it, expect } from 'vitest';
import { LoginRateLimiter, attemptKeys, tooManyAttempts } from './rateLimit';
// Note: real callers weight the global key (GLOBAL_KEY_WEIGHT) so one account's lockout
// doesn't lock everyone; the tests below pass weights explicitly where that matters.

const opts = { maxFailures: 3, windowMs: 60_000, lockoutMs: 10_000, maxLockoutMs: 40_000 };

describe('LoginRateLimiter', () => {
  it('locks a key after maxFailures within the window, then releases it', () => {
    const rl = new LoginRateLimiter(opts);
    const keys = ['acct:a', 'addr:x'];
    expect(rl.check(keys, 0).allowed).toBe(true);
    rl.recordFailure(keys, 0);
    rl.recordFailure(keys, 1);
    const v = rl.recordFailure(keys, 2);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterMs).toBe(10_000);
    expect(rl.check(keys, 5_000).allowed).toBe(false);
    expect(rl.check(keys, 10_003).allowed).toBe(true);
  });

  it('failures outside the window do not accumulate', () => {
    const rl = new LoginRateLimiter(opts);
    rl.recordFailure(['k'], 0);
    rl.recordFailure(['k'], 1);
    rl.recordFailure(['k'], 70_000); // first two expired
    expect(rl.check(['k'], 70_001).allowed).toBe(true);
  });

  it('doubles the lockout on repeat offences, capped', () => {
    const rl = new LoginRateLimiter(opts);
    let t = 0;
    const lockOnce = () => {
      for (let i = 0; i < 3; i++) rl.recordFailure(['k'], t++);
      return rl.check(['k'], t).retryAfterMs;
    };
    expect(lockOnce()).toBeGreaterThan(9_000);
    t += 10_001;
    expect(lockOnce()).toBeGreaterThan(19_000);
    t += 20_001;
    expect(lockOnce()).toBeGreaterThan(39_000);
    t += 40_001;
    expect(lockOnce()).toBeLessThanOrEqual(40_000); // capped
  });

  it('an account stays locked even when the attacker changes address', () => {
    const rl = new LoginRateLimiter(opts);
    const w = { 'login:global': 10 };
    for (let i = 0; i < 3; i++) rl.recordFailure(attemptKeys('login', 'Boss@Co.com', `100.64.0.${i}`), i, w);
    expect(rl.check(attemptKeys('login', 'boss@co.com', '100.64.9.9'), 10).allowed).toBe(false);
    // A different account from a fresh address is unaffected.
    expect(rl.check(attemptKeys('login', 'clerk@co.com', '100.64.9.9'), 10).allowed).toBe(true);
  });

  it('weights let the global key tolerate more failures', () => {
    const rl = new LoginRateLimiter(opts);
    for (let i = 0; i < 5; i++) rl.recordFailure([`acct:${i}`, 'global'], i, { global: 2 });
    expect(rl.check(['global'], 10).allowed).toBe(true);
    rl.recordFailure(['acct:x', 'global'], 11, { global: 2 });
    expect(rl.check(['global'], 12).allowed).toBe(false);
  });

  it('success clears the account/address counters', () => {
    const rl = new LoginRateLimiter(opts);
    rl.recordFailure(['k'], 0);
    rl.recordFailure(['k'], 1);
    rl.recordSuccess(['k']);
    rl.recordFailure(['k'], 2);
    expect(rl.check(['k'], 3).allowed).toBe(true);
  });

  it('counts attempts in flight: a parallel burst cannot all pass the gate before failures land', () => {
    const rl = new LoginRateLimiter(opts);
    const keys = attemptKeys('login', 'boss@co.com', '100.64.0.7');
    const tickets = Array.from({ length: 10 }, () => rl.begin(keys, 0));
    expect(tickets.filter((t) => t.allowed)).toHaveLength(3); // maxFailures
    // Each admitted guess fails -> the account locks; releasing doesn't reopen it.
    for (const t of tickets.filter((t) => t.allowed)) {
      rl.recordFailure(keys, 1);
      t.release();
      t.release(); // idempotent
    }
    expect(rl.begin(keys, 2).allowed).toBe(false);
    // A finished attempt frees its slot.
    const rl2 = new LoginRateLimiter(opts);
    const t1 = rl2.begin(['k'], 0);
    t1.release();
    expect([rl2.begin(['k'], 0), rl2.begin(['k'], 0), rl2.begin(['k'], 0)].every((t) => t.allowed)).toBe(true);
  });

  it('network peers cannot lock out sign-in on the host machine itself', () => {
    const rl = new LoginRateLimiter(opts);
    for (let i = 0; i < 5; i++) rl.recordFailure(attemptKeys('login', 'owner@co.com', `100.64.1.${i}`), i, {});
    expect(rl.check(attemptKeys('login', 'owner@co.com', '100.64.9.9'), 10).allowed).toBe(false);
    expect(rl.check(attemptKeys('login', 'owner@co.com', 'local'), 10).allowed).toBe(true);
  });

  it('formats a friendly 429 body', () => {
    expect(tooManyAttempts(30_000).retryAfter).toBe('30');
    expect(tooManyAttempts(30_000).body.error).toMatch(/30 seconds/);
    expect(tooManyAttempts(600_000).body.error).toMatch(/10 minutes/);
  });
});
