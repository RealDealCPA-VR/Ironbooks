/**
 * Pure tests for the recurring-pattern detector (no database).
 */
import { describe, it, expect } from 'vitest';
import { detectPatterns } from './aiRecurring';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
let n = 0;
const doc = (date: string, total: string, payee = 'Comcast', vendorId: string | null = 'v1', docType: 'bill' | 'expense' = 'expense') => ({
  id: `doc${++n}`,
  docType,
  vendorId,
  payee,
  date: d(date),
  total,
});

describe('detectPatterns', () => {
  it('finds a monthly bill with a stable amount', () => {
    const docs = ['2026-03-03', '2026-04-02', '2026-05-04', '2026-06-03', '2026-07-03'].map((x) => doc(x, '89.99'));
    const [s] = detectPatterns(docs, d('2026-07-20'));
    expect(s.frequency).toBe('monthly');
    expect(s.typicalAmount).toBe('89.99');
    expect(s.amountVaries).toBe(false);
    expect(s.nextDate.slice(0, 10)).toBe('2026-08-03');
    expect(s.sourceDocId).toBe(docs[docs.length - 1].id);
  });

  it('handles quarterly and yearly cadences', () => {
    const q = ['2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15'].map((x) => doc(x, '1200.00', 'IRS', 'irs'));
    expect(detectPatterns(q, d('2025-11-01'))[0].frequency).toBe('quarterly');
    const y = ['2023-02-01', '2024-02-01', '2025-02-01'].map((x) => doc(x, '450.00', 'Insurer', 'ins'));
    expect(detectPatterns(y, d('2025-06-01'))[0].frequency).toBe('yearly');
  });

  it('ignores irregular timing, volatile amounts, too few docs and dead patterns', () => {
    const irregular = ['2026-01-01', '2026-01-09', '2026-03-20', '2026-03-25'].map((x) => doc(x, '50.00', 'A', 'a'));
    const volatile = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'].map((x, i) => doc(x, ['10.00', '400.00', '35.00', '900.00'][i], 'B', 'b'));
    const few = ['2026-05-01', '2026-06-01'].map((x) => doc(x, '20.00', 'C', 'c'));
    const dead = ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01'].map((x) => doc(x, '20.00', 'D', 'd'));
    expect(detectPatterns([...irregular, ...volatile, ...few, ...dead], d('2026-06-15'))).toEqual([]);
  });

  it('groups free-text payees by normalized name and skips refunds', () => {
    const docs = [
      doc('2026-03-05', '15.00', 'NETFLIX.COM 1234', null),
      doc('2026-04-05', '15.00', 'Netflix.com', null),
      doc('2026-05-05', '15.00', 'NETFLIX.COM #88', null),
      doc('2026-05-06', '-15.00', 'NETFLIX.COM', null),
    ];
    const r = detectPatterns(docs, d('2026-05-20'));
    expect(r).toHaveLength(1);
    expect(r[0].occurrences).toBe(3);
    expect(r[0].vendorId).toBeNull();
  });

  it('flags slightly varying amounts as approximate', () => {
    const docs = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'].map((x, i) => doc(x, ['100.00', '104.00', '98.00', '101.00'][i], 'Power Co', 'p'));
    const [s] = detectPatterns(docs, d('2026-06-10'));
    expect(s.amountVaries).toBe(true);
    expect(s.typicalAmount).toBe('100.50');
  });
});
