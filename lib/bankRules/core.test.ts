/**
 * Pure bank-rules logic (team bankrules): description normalization, the safe wildcard
 * matcher, rule conditions + precedence, split validation and the confidence math.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_CONFIDENCE_CAP,
  combineSignals,
  globMatch,
  historyConfidence,
  normalizeDescription,
  patternOf,
  pickRule,
  ruleMatches,
  splitError,
  type RuleLike,
} from './core';

describe('normalizeDescription', () => {
  it('strips store numbers, dates, card digits and bank boilerplate', () => {
    expect(normalizeDescription('PURCHASE AUTHORIZED ON 03/14 SHELL OIL 57444 HOUSTON TX CARD 1234')).toBe('SHELL OIL');
    expect(normalizeDescription('Shell Oil #12345 Dallas TX 04/02/2025')).toBe('SHELL OIL');
    expect(normalizeDescription('POS DEBIT SHELL OIL 9911 XXXX5521')).toBe('SHELL OIL');
    expect(normalizeDescription('CHECKCARD 0312 STARBUCKS STORE 08812 SEATTLE')).toBe('STARBUCKS STORE');
    expect(normalizeDescription('AMZN Mktp US*2K4AB1 Amzn.com/bill WA')).toBe('AMZN MKTP US');
    expect(normalizeDescription('DEBIT CARD PURCHASE 2024-05-01 HOME DEPOT 4521')).toBe('HOME DEPOT');
    expect(normalizeDescription('ADOBE *CREATIVE CLOUD 14MAR')).toBe('ADOBE CREATIVE CLOUD');
  });

  it('groups different locations / days / cards of the same merchant together', () => {
    const a = normalizeDescription('SHELL OIL 57444 HOUSTON TX 03/14 CARD 1234');
    const b = normalizeDescription('SHELL OIL 12001 AUSTIN TX 04/22 CARD 9876');
    expect(a).toBe(b);
  });

  it('keeps short numbers that are part of a name, and never returns empty for real text', () => {
    expect(normalizeDescription('7-ELEVEN 34012')).toBe('7 ELEVEN');
    expect(normalizeDescription('123456')).toBe('');
    expect(normalizeDescription('Deposit 445566 ref')).toBe('DEPOSIT');
    expect(normalizeDescription(null)).toBe('');
  });

  it('patternOf prefers the description, falls back to the payee', () => {
    expect(patternOf({ description: 'SHELL OIL 57444', payee: 'Shell' })).toBe('SHELL OIL');
    expect(patternOf({ description: null, payee: 'Joe Plumbing' })).toBe('JOE PLUMBING');
  });
});

describe('globMatch (regex-safe pattern)', () => {
  it('* and ? wildcards, case-insensitive, whole text', () => {
    expect(globMatch('SHELL OIL 57444', 'shell*')).toBe(true);
    expect(globMatch('SHELL OIL 57444', '*oil*')).toBe(true);
    expect(globMatch('SHELL OIL', 'sh?ll oil')).toBe(true);
    expect(globMatch('SHELL OIL', 'shell')).toBe(false);
    expect(globMatch('abc', 'a*c*')).toBe(true);
  });

  it('regex metacharacters are literal and pathological patterns finish fast', () => {
    expect(globMatch('a.b', 'a.b')).toBe(true);
    expect(globMatch('axb', 'a.b')).toBe(false);
    expect(globMatch('(x)+', '(x)+')).toBe(true);
    const text = 'a'.repeat(5000) + 'b';
    const pattern = '*a*a*a*a*a*a*a*a*a*a*a*a*c';
    const t0 = Date.now();
    expect(globMatch(text, pattern)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

function rule(p: Partial<RuleLike> & { id: string }): RuleLike {
  return {
    name: p.id,
    matchField: 'any',
    matchOperator: 'contains',
    matchValue: '',
    priority: 0,
    enabled: true,
    isActive: true,
    createdAt: new Date('2025-01-01'),
    ...p,
  };
}

describe('ruleMatches conditions', () => {
  const fuel = { description: 'SHELL OIL 57444 HOUSTON', payee: null, amount: '-42.10', bankAccountId: 'bank-1' };

  it('text operators on raw and normalized text', () => {
    expect(ruleMatches(rule({ id: 'a', matchValue: 'shell' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', matchOperator: 'starts_with', matchValue: 'SHELL OIL' }), fuel)).toBe(true);
    // "is exactly" matches the normalized merchant even though the raw text has a store number.
    expect(ruleMatches(rule({ id: 'a', matchOperator: 'equals', matchValue: 'shell oil' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', matchOperator: 'equals', matchValue: 'shell' }), fuel)).toBe(false);
    expect(ruleMatches(rule({ id: 'a', matchOperator: 'pattern', matchValue: 'shell*houston' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', matchField: 'payee', matchValue: 'shell' }), fuel)).toBe(false);
  });

  it('money in / out, amount equals / range (absolute) and bank account', () => {
    expect(ruleMatches(rule({ id: 'a', matchValue: 'shell', direction: 'out' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', matchValue: 'shell', direction: 'in' }), fuel)).toBe(false);
    expect(ruleMatches(rule({ id: 'a', amountMin: '42.10', amountMax: '42.10' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', amountMin: '42.11', amountMax: '42.11' }), fuel)).toBe(false);
    expect(ruleMatches(rule({ id: 'a', amountMin: '10', amountMax: '50' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', amountMin: '50' }), fuel)).toBe(false);
    expect(ruleMatches(rule({ id: 'a', matchValue: 'shell', bankAccountId: 'bank-1' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', matchValue: 'shell', bankAccountId: 'bank-2' }), fuel)).toBe(false);
    // Legacy amount rules compare numerically.
    expect(ruleMatches(rule({ id: 'a', matchField: 'amount', matchValue: '42.1' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', matchField: 'amount', matchValue: '-42.10' }), fuel)).toBe(true);
    expect(ruleMatches(rule({ id: 'a', matchField: 'amount', matchValue: '+42.10' }), fuel)).toBe(false);
  });
});

describe('pickRule precedence', () => {
  const txn = { description: 'SHELL OIL 57444', amount: '-40.00', bankAccountId: 'b' };

  it('highest priority wins; ties go to the older rule; disabled / deleted rules are skipped', () => {
    const low = rule({ id: 'low', matchValue: 'shell', priority: 1 });
    const high = rule({ id: 'high', matchValue: 'oil', priority: 5 });
    expect(pickRule([low, high], txn)?.id).toBe('high');

    const older = rule({ id: 'older', matchValue: 'shell', priority: 3, createdAt: new Date('2024-01-01') });
    const newer = rule({ id: 'newer', matchValue: 'shell', priority: 3, createdAt: new Date('2025-06-01') });
    expect(pickRule([newer, older], txn)?.id).toBe('older');

    expect(pickRule([{ ...high, enabled: false }, low], txn)?.id).toBe('low');
    expect(pickRule([{ ...high, isActive: false }, low], txn)?.id).toBe('low');
    expect(pickRule([rule({ id: 'x', matchValue: 'chevron' })], txn)).toBeNull();
  });

  it('a more specific rule placed higher beats a general one', () => {
    const general = rule({ id: 'general', matchValue: 'shell', priority: 1 });
    const big = rule({ id: 'big', matchValue: 'shell', amountMin: '100', priority: 2 });
    expect(pickRule([general, big], txn)?.id).toBe('general');
    expect(pickRule([general, big], { ...txn, amount: '-150.00' })?.id).toBe('big');
  });
});

describe('splitError', () => {
  it('requires 2+ lines, positive percents summing to exactly 100', () => {
    expect(splitError(null)).toBeNull();
    expect(splitError([{ accountId: 'a', percent: '60' }, { accountId: 'b', percent: '40' }])).toBeNull();
    expect(splitError([{ accountId: 'a', percent: '33.3333' }, { accountId: 'b', percent: '66.6667' }])).toBeNull();
    expect(splitError([{ accountId: 'a', percent: '100' }])).toMatch(/at least two/);
    expect(splitError([{ accountId: 'a', percent: '60' }, { accountId: 'b', percent: '30' }])).toMatch(/add up to 100/);
    expect(splitError([{ accountId: 'a', percent: '120' }, { accountId: 'b', percent: '-20' }])).toMatch(/more than 0/);
    expect(splitError([{ accountId: '', percent: '50' }, { accountId: 'b', percent: '50' }])).toMatch(/needs an account/);
  });
});

describe('confidence math', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it('history: more consistent choices → more confidence, capped at 97%', () => {
    const one = historyConfidence([{ accountId: 'fuel', classId: null, createdAt: daysAgo(1) }], now)!;
    const two = historyConfidence([1, 2].map((d) => ({ accountId: 'fuel', classId: null, createdAt: daysAgo(d) })), now)!;
    const five = historyConfidence([1, 2, 3, 4, 5].map((d) => ({ accountId: 'fuel', classId: null, createdAt: daysAgo(d) })), now)!;
    const many = historyConfidence(Array.from({ length: 20 }, (_, i) => ({ accountId: 'fuel', classId: null, createdAt: daysAgo(i) })), now)!;
    expect(one.confidence).toBeCloseTo(0.65, 2);
    expect(two.confidence).toBeCloseTo(0.75, 2);
    expect(five.confidence).toBeGreaterThanOrEqual(0.9);
    expect(many.confidence).toBeLessThanOrEqual(0.97);
    expect(five.count).toBe(5);
  });

  it('history: mixed choices lower confidence and recent choices outweigh old ones', () => {
    const mixed = historyConfidence(
      [
        { accountId: 'fuel', classId: null, createdAt: daysAgo(1) },
        { accountId: 'fuel', classId: null, createdAt: daysAgo(2) },
        { accountId: 'meals', classId: null, createdAt: daysAgo(3) },
        { accountId: 'meals', classId: null, createdAt: daysAgo(400) },
        { accountId: 'meals', classId: null, createdAt: daysAgo(500) },
      ],
      now,
    )!;
    // 3 meals vs 2 fuel by count, but the 2 old meals decayed — fuel (recent) wins.
    expect(mixed.accountId).toBe('fuel');
    expect(mixed.total).toBe(5);
    expect(mixed.confidence).toBeLessThan(0.75);
    expect(historyConfidence([], now)).toBeNull();
  });

  it('rule wins outright at 98%, 99% when history agrees', () => {
    const r = combineSignals([
      { source: 'history', accountId: 'meals', confidence: 0.95, reason: 'You chose Meals 9 times' },
      { source: 'rule', accountId: 'fuel', confidence: 0.98, reason: 'Matched rule "Shell"' },
    ])!;
    expect(r.accountId).toBe('fuel');
    expect(r.source).toBe('rule');
    expect(r.confidence).toBe(98);
    const agree = combineSignals([
      { source: 'rule', accountId: 'fuel', confidence: 0.98, reason: 'Matched rule "Shell"' },
      { source: 'history', accountId: 'fuel', confidence: 0.75, reason: 'You chose Fuel 2 times' },
    ])!;
    expect(agree.confidence).toBe(99);
    expect(agree.reason).toContain('Matched rule "Shell"');
    expect(agree.reason).toContain('You chose Fuel 2 times');
  });

  it('agreeing history + AI combine (1 − Π(1 − c)); disagreement lowers confidence', () => {
    const both = combineSignals([
      { source: 'history', accountId: 'fuel', confidence: 0.75, reason: 'You chose Fuel 2 times' },
      { source: 'ai', accountId: 'fuel', confidence: 0.6, reason: 'AI 60%' },
    ])!;
    expect(both.confidence).toBe(90); // 1 − 0.25 × 0.4
    expect(both.agreeing).toEqual(['history', 'ai']);
    const split = combineSignals([
      { source: 'history', accountId: 'fuel', confidence: 0.75, reason: 'You chose Fuel 2 times' },
      { source: 'ai', accountId: 'meals', confidence: 0.6, reason: 'AI thinks Meals' },
    ])!;
    expect(split.accountId).toBe('fuel');
    expect(split.confidence).toBe(60); // 0.75 − 0.25 × 0.6
    expect(split.reason).toContain('but');
  });

  it('AI alone is capped below the high-confidence bar', () => {
    const ai = combineSignals([{ source: 'ai', accountId: 'fuel', confidence: 0.99, reason: 'AI' }])!;
    expect(ai.confidence).toBe(Math.round(AI_CONFIDENCE_CAP * 100));
    expect(ai.confidence).toBeLessThan(90);
    expect(combineSignals([])).toBeNull();
  });
});
