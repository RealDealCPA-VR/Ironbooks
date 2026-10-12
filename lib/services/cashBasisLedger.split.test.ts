import { describe, expect, it } from 'vitest';
import { Money } from '@/lib/money';
import { splitCumulative } from './cashBasisLedger';

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('splitCumulative is house-monotone and exact', () => {
  it('random documents, random settlement sequences (incl. mixed signs and reversals)', () => {
    const r = rng(20261012);
    for (let trial = 0; trial < 400; trial++) {
      const n = 1 + Math.floor(r() * 5);
      const mixed = r() < 0.4;
      const nets = Array.from({ length: n }, (_, i) => {
        const cents = 1 + Math.floor(r() * (r() < 0.3 ? 300 : 500000));
        const neg = mixed ? (i === 0 ? true : r() < 0.5) : true;
        return Money.of((neg ? -cents : cents) / 100);
      });
      const net = nets.reduce((a, x) => a.plus(x), Money.zero());
      if (net.isZero()) continue;
      const base = net.abs();
      // cumulative settlements: mostly up, sometimes down (bounced check), ending fully paid
      const steps: number[] = [];
      let cum = 0;
      const baseCents = Math.round(base.toNumber() * 100);
      while (cum < baseCents) {
        const up = r() < 0.85 || cum === 0;
        const d = 1 + Math.floor(r() * Math.max(1, baseCents / 3));
        cum = up ? Math.min(baseCents, cum + d) : Math.max(0, cum - d);
        steps.push(cum);
      }
      let prev = nets.map(() => Money.zero());
      let prevCum = 0;
      for (const c of steps) {
        const frac = Money.div(c / 100, base);
        const cur = splitCumulative(nets, frac, prev);
        const total = cur.reduce((a, x) => a.plus(x), Money.zero());
        expect(total.toFixed(2)).toBe(Money.round2(Money.mul(net, frac.greaterThanOrEqualTo(1) ? 1 : frac)).toFixed(2));
        cur.forEach((x, i) => {
          const inc = x.minus(prev[i]);
          const dir = c >= prevCum ? nets[i].s : -nets[i].s;
          // every line moves only in the settlement's direction for its sign
          expect(inc.isZero() || inc.s === dir, `trial ${trial} line ${i} moved ${inc.toFixed(2)}`).toBe(true);
          expect(x.abs().lessThanOrEqualTo(nets[i].abs())).toBe(true);
        });
        prev = cur;
        prevCum = c;
      }
      prev.forEach((x, i) => expect(x.toFixed(2)).toBe(nets[i].toFixed(2)));
    }
  });
});

describe('splitCumulative stays within a cent of each line\'s pro-rata share (quota)', () => {
  /** exact share of line i in its sign group at the group's recognized total */
  function groupShares(nets: ReturnType<typeof Money.of>[], cur: ReturnType<typeof Money.of>[]) {
    return nets.map((n, i) => {
      const same = nets.map((x, k) => k).filter((k) => nets[k].s === n.s);
      const tot = same.reduce((a, k) => a.plus(nets[k]), Money.zero());
      const got = same.reduce((a, k) => a.plus(cur[k]), Money.zero());
      return Money.div(Money.mul(got, n), tot);
    });
  }

  it('one-third of $10,000 plus many $0.50 lines: the big line gets 3,333.33', () => {
    for (const k of [10, 40, 200]) {
      const nets = [Money.of('-10000.00'), ...Array.from({ length: k }, () => Money.of('-0.50'))];
      const total = nets.reduce((a, x) => a.plus(x), Money.zero());
      const frac = Money.div(Money.mul(total, Money.div(1, 3)).abs().toFixed(2), total.abs());
      const cur = splitCumulative(nets, frac);
      // k = 10 / 40: the payment is an exact third, so the big line's share is 3,333.33(3)
      if (k !== 200) expect(cur[0].toFixed(2)).toBe('-3333.33');
      cur.forEach((x, i) => expect(x.minus(Money.mul(nets[i], frac)).abs().lessThan('0.01')).toBe(true));
    }
  });

  it('random payment sequences (no reversals): every line within one cent of its share at every step, monotone, exact at the end', () => {
    const r = rng(424242);
    for (let trial = 0; trial < 400; trial++) {
      const n = 1 + Math.floor(r() * 25);
      const mixed = r() < 0.4;
      const nets = Array.from({ length: n }, (_, i) => {
        const c = 1 + Math.floor(r() * (r() < 0.4 ? 200 : 2_000_000));
        const neg = mixed ? (i === 0 ? true : r() < 0.6) : true;
        return Money.of((neg ? -c : c) / 100);
      });
      const net = nets.reduce((a, x) => a.plus(x), Money.zero());
      if (net.isZero()) continue;
      const base = net.abs();
      const bc = Math.round(base.toNumber() * 100);
      let prev = nets.map(() => Money.zero());
      let cum = 0;
      while (cum < bc) {
        cum = Math.min(bc, cum + 1 + Math.floor(r() * Math.max(1, bc / 4)));
        const frac = Money.div(cum / 100, base);
        const cur = splitCumulative(nets, frac, prev);
        const share = groupShares(nets, cur);
        cur.forEach((x, i) => {
          expect(x.minus(share[i]).abs().lessThan('0.01'), `trial ${trial} line ${i}: ${x.toFixed(2)} vs ${share[i].toFixed(4)}`).toBe(true);
          const inc = x.minus(prev[i]);
          expect(inc.isZero() || inc.s === nets[i].s).toBe(true);
        });
        prev = cur;
      }
      prev.forEach((x, i) => expect(x.toFixed(2)).toBe(nets[i].toFixed(2)));
    }
  });
});
