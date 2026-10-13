import { describe, it, expect } from 'vitest';
import { calculateStateWithholding, UNCONFIRMED_TABLES } from './statePayrollTax';

const base = { wagesPerPeriod: '2000', periodsPerYear: 26, stateW4: { filingStatus: 'single' } } as const;

describe('state withholding figures not yet confirmed against the published guide', () => {
  it('a paycheck using an unconfirmed table gets a check-the-amount note', () => {
    const ga = calculateStateWithholding({ ...base, state: 'GA', year: 2026 } as never);
    expect(ga.notes.some((n) => /not yet confirmed/.test(n) && /Georgia 2026/.test(n))).toBe(true);
    expect(Number(ga.amount)).toBeGreaterThan(0);
  });
  it('confirmed tables carry no such note', () => {
    const nc = calculateStateWithholding({ ...base, state: 'NC', year: 2026 } as never);
    expect(nc.notes.some((n) => /not yet confirmed/.test(n))).toBe(false);
  });
  it('lists the figures the review flagged', () => {
    expect(UNCONFIRMED_TABLES.GA).toContain(2026);
    for (const s of ['IL', 'KY', 'MI', 'NY', 'MA', 'VA', 'OH', 'UT', 'CA']) expect(UNCONFIRMED_TABLES[s]).toContain(2025);
  });
});
