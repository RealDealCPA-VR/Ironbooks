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
        const cur = splitCumulative(nets, frac);
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
