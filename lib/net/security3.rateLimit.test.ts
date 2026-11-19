/**
 * Security plan 3.4: sign-in limits over the network (lib/net/rateLimit.ts), with the real limits
 * (loginLimiter()). One device must not be able to lock a named teammate out, or everyone out for
 * an hour, while guessing from many addresses stays bounded per account; the host's own sign-in
 * and a program on this computer outside Ironbooks stay apart.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { attemptKeys, GLOBAL_KEY_WEIGHT, loginLimiter, resetLimiter, type LoginRateLimiter } from './rateLimit';
import { UNVERIFIED_LOCAL_ADDR } from './requestInfo';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;

function fresh(): LoginRateLimiter {
  const g = globalThis as unknown as { __bkaLoginLimiter?: unknown; __bkaResetLimiter?: unknown };
  g.__bkaLoginLimiter = undefined;
  g.__bkaResetLimiter = undefined;
  return loginLimiter();
}

/** One wrong password the way the routes do it: admitted first, failure recorded, released. */
function guess(l: LoginRateLimiter, account: string | null, addr: string, now: number): { admitted: boolean; retryAfterMs: number } {
  const keys = attemptKeys('login', account, addr);
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = l.begin(keys, now, weights);
  if (!gate.allowed) return { admitted: false, retryAfterMs: gate.retryAfterMs };
  l.recordFailure(keys, now, weights);
  gate.release();
  return { admitted: true, retryAfterMs: 0 };
}

function signIn(l: LoginRateLimiter, account: string, addr: string, now: number): boolean {
  const keys = attemptKeys('login', account, addr);
  const gate = l.begin(keys, now, { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT });
  if (!gate.allowed) return false;
  l.recordSuccess(keys.slice(0, -1), now);
  gate.release();
  return true;
}

const canTry = (l: LoginRateLimiter, account: string | null, addr: string, now: number) => l.check(attemptKeys('login', account, addr), now).allowed;

describe('network sign-in limits', () => {
  let l: LoginRateLimiter;
  beforeEach(() => {
    l = fresh();
  });

  it("five wrong passwords from one device lock only that device out of that teammate's account", () => {
    for (let i = 0; i < 5; i++) expect(guess(l, 'pat@co.com', '100.64.0.66', T0 + i).admitted).toBe(true);
    expect(canTry(l, 'pat@co.com', '100.64.0.66', T0 + 10)).toBe(false);
    // Pat, at Pat's own computer, and the owner at the host: unaffected.
    expect(canTry(l, 'pat@co.com', '100.64.0.7', T0 + 10)).toBe(true);
    expect(canTry(l, 'pat@co.com', 'local', T0 + 10)).toBe(true);
    // The guessing device is held to its own lock, which doubles as before.
    expect(l.check(attemptKeys('login', 'pat@co.com', '100.64.0.66'), T0 + 10).retryAfterMs).toBeLessThanOrEqual(MIN);
  });

  it('wrong passwords from everywhere slow the network down for a minute at most; they never lock it for an hour', () => {
    // 50 devices, one wrong guess each at different accounts: the overall throttle is full.
    for (let i = 0; i < 50; i++) guess(l, `user${i}@co.com`, `10.0.${i}.1`, T0);
    let v = l.check(attemptKeys('login', 'sam@co.com', '10.9.9.9'), T0 + 1);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterMs).toBeLessThanOrEqual(MIN);
    // Hammering on from fresh addresses never makes the wait longer than a minute.
    let t = T0 + 1;
    for (let round = 0; round < 200; round++) {
      const r = guess(l, `x${round}@co.com`, `10.1.${round % 250}.${round}`, t);
      expect(r.retryAfterMs).toBeLessThanOrEqual(MIN);
      t += r.admitted ? 1000 : Math.max(r.retryAfterMs, 1000);
    }
    v = l.check(attemptKeys('login', 'sam@co.com', '10.9.9.9'), t + MIN);
    expect(v.allowed).toBe(true);
    // The host's own sign-in was never touched.
    expect(canTry(l, 'owner@co.com', 'local', t)).toBe(true);
  });

  it('guessing one account from many addresses is bounded: 30, then one every 5 minutes', () => {
    let admitted = 0;
    let t = T0;
    const end = T0 + 24 * HOUR;
    let addr = 0;
    while (t < end) {
      // A fresh address for every guess (an attacker with a whole subnet).
      const r = guess(l, 'pat@co.com', `10.${(addr >> 16) & 255}.${(addr >> 8) & 255}.${addr & 255}`, t);
      addr++;
      if (r.admitted) admitted++;
      expect(r.retryAfterMs).toBeLessThanOrEqual(5 * MIN);
      t += r.admitted ? 100 : Math.max(r.retryAfterMs, 100);
    }
    // 30 at once, then 12 an hour: at most 30 + 288 (+1 for the edge) in a day.
    expect(admitted).toBeGreaterThan(30);
    expect(admitted).toBeLessThanOrEqual(30 + 24 * 12 + 1);
  });

  it('a teammate at a computer they signed in from is never slowed by someone else guessing', () => {
    expect(signIn(l, 'pat@co.com', '100.64.0.7', T0)).toBe(true);
    for (let i = 0; i < 300; i++) guess(l, i % 2 ? 'pat@co.com' : `u${i}@co.com`, `10.2.${i >> 8}.${i & 255}`, T0 + i);
    // The account and overall throttles are full for everyone else...
    expect(canTry(l, 'pat@co.com', '100.64.0.99', T0 + 400)).toBe(false);
    // ...but not for Pat's own computer.
    const gate = l.begin(attemptKeys('login', 'pat@co.com', '100.64.0.7'), T0 + 400, {});
    expect(gate.allowed).toBe(true);
    gate.release();
  });

  it('a trusted device that keeps getting it wrong loses that and is held like any other', () => {
    expect(signIn(l, 'pat@co.com', '100.64.0.7', T0)).toBe(true);
    for (let i = 0; i < 300; i++) guess(l, 'pat@co.com', `10.3.${i >> 8}.${i & 255}`, T0 + i);
    for (let i = 0; i < 5; i++) guess(l, 'pat@co.com', '100.64.0.7', T0 + 400 + i);
    // Its own lock (1 minute)...
    expect(canTry(l, 'pat@co.com', '100.64.0.7', T0 + 500)).toBe(false);
    // ...and once that is over, the account throttle (still full) applies to it too.
    expect(canTry(l, 'pat@co.com', '100.64.0.7', T0 + 400 + MIN + 1000)).toBe(false);
  });

  it('a program on this computer outside Ironbooks can lock out neither the owner nor a teammate', () => {
    expect(UNVERIFIED_LOCAL_ADDR).not.toBe('local');
    let t = T0;
    const end = T0 + 24 * HOUR;
    let admitted = 0;
    let longestWait = 0;
    let tries = 0;
    while (t < end) {
      // It guesses the teammate's password (and now and then the owner's) as fast as it is let.
      const r = guess(l, tries % 10 === 9 ? 'owner@co.com' : 'pat@co.com', UNVERIFIED_LOCAL_ADDR, t);
      tries++;
      if (r.admitted) admitted++;
      longestWait = Math.max(longestWait, r.retryAfterMs);
      expect(canTry(l, 'owner@co.com', 'local', t)).toBe(true);
      // A teammate on a computer that never signed in before is not held up either: one source's
      // lockouts keep it below the account throttle.
      expect(canTry(l, 'pat@co.com', '100.64.0.42', t)).toBe(true);
      expect(canTry(l, 'owner@co.com', '100.64.0.42', t)).toBe(true);
      t += r.admitted ? 100 : Math.max(r.retryAfterMs, 100);
    }
    // It was held to its own, growing lockouts: about 140 guesses a day, waits up to an hour.
    expect(admitted).toBeLessThanOrEqual(150);
    expect(longestWait).toBeGreaterThan(30 * MIN);
  });

  it("the host's own sign-in keeps its own realm and locks as before", () => {
    for (let i = 0; i < 5; i++) guess(l, 'owner@co.com', 'local', T0 + i);
    expect(canTry(l, 'owner@co.com', 'local', T0 + 10)).toBe(false);
    expect(canTry(l, 'owner@co.com', '100.64.0.7', T0 + 10)).toBe(true);
    expect(canTry(l, 'owner@co.com', UNVERIFIED_LOCAL_ADDR, T0 + 10)).toBe(true);
    expect(attemptKeys('login', 'Owner@Co.com', 'local')).toEqual(['login:acct:local:owner@co.com', 'login:addr:local', 'login:global:local']);
  });

  it('keys: the overall key stays last; the address-free filter (closing-date password) keeps the device key', () => {
    const keys = attemptKeys('closing-password', 'c1:u1', 'fd7a:115c:a1e0::9');
    expect(keys[keys.length - 1]).toBe('closing-password:global-slow');
    const filtered = keys.filter((k) => !k.includes(':addr:'));
    expect(filtered).toEqual([
      'closing-password:acct-at:fd7a%3A115c%3Aa1e0%3A%3A9|c1:u1',
      'closing-password:acct-slow:c1:u1',
      'closing-password:global-slow',
    ]);
    // No account: the address lock and the overall throttle.
    expect(attemptKeys('reset', null, '10.0.0.5')).toEqual(['reset:addr:10.0.0.5', 'reset:global-slow']);
    // An address cannot be spelled to collide with another device's key.
    expect(attemptKeys('login', 'b', 'a|x')[0]).not.toBe(attemptKeys('login', 'x|b', 'a')[0]);
  });

  it('password-reset requests follow the same rule', () => {
    const r = resetLimiter();
    for (let i = 0; i < 5; i++) r.recordFailure(attemptKeys('reset-request', 'pat@co.com', '100.64.0.66'), T0 + i);
    expect(r.check(attemptKeys('reset-request', 'pat@co.com', '100.64.0.66'), T0 + 10).allowed).toBe(false);
    expect(r.check(attemptKeys('reset-request', 'pat@co.com', '100.64.0.7'), T0 + 10).allowed).toBe(true);
  });
});
