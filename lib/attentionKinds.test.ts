/**
 * "Needs attention" pure helpers (team home): the per-kind item key shapes (snooze / dismiss only
 * accepts keys the inbox can produce) and which currency an item's amount is shown in.
 */
import { describe, expect, it } from 'vitest';
import { ATTENTION_KINDS, attentionAmountCurrency, parseAttentionKey } from './attentionKinds';

const U = '3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b';

describe('parseAttentionKey', () => {
  it('accepts the shape each kind produces', () => {
    for (const k of ['bank_txn', 'overdue_invoice', 'bill_due', 'ai_error', 'todo', 'undeposited'] as const) {
      expect(parseAttentionKey(`${k}:${U}`)).toEqual({ kind: k, id: U });
    }
    expect(parseAttentionKey(`reconcile:${U}:2026-05-31`)).toEqual({ kind: 'reconcile', id: `${U}:2026-05-31` });
    expect(parseAttentionKey('payroll_tax:2026-05')).toEqual({ kind: 'payroll_tax', id: '2026-05' });
    expect(parseAttentionKey('backup:never')).toEqual({ kind: 'backup', id: 'never' });
    expect(parseAttentionKey('backup:2026-06-01')).toEqual({ kind: 'backup', id: '2026-06-01' });
    expect(parseAttentionKey('backup:2026-06-15')).toEqual({ kind: 'backup', id: '2026-06-15' });
    expect(parseAttentionKey(`reconcile:${U}:2026-02-28`)?.kind).toBe('reconcile');
  });

  it('covers every kind', () => {
    // Every kind has a shape (a new kind without one would make the lookup throw).
    for (const k of ATTENTION_KINDS) expect(() => parseAttentionKey(`${k}:x`)).not.toThrow();
  });

  it('refuses anything else', () => {
    const bad = [
      'bank_txn:not-a-uuid', // the reviewer's probe: would break the uuid NOT IN query
      `bank_txn:${U}x`,
      `bank_txn:${U}:2026-05-31`,
      'bank_txn:',
      `todo:${U.slice(0, 35)}`,
      `reconcile:${U}`,
      `reconcile:${U}:2026-5-31`,
      `reconcile:${U}:2026-02-32`,
      'reconcile:abc:2026-05-31',
      'payroll_tax:2026-13',
      'payroll_tax:2026-05-15',
      `payroll_tax:${U}`,
      'backup:soon',
      `backup:${U}`,
      `nope:${U}`,
      U,
      '',
      ':x',
      `bank_txn:${U}' OR 1=1 --`,
      `${'bank_txn:'}${'a'.repeat(300)}`,
      null,
      42,
      undefined,
    ];
    for (const k of bad) expect(parseAttentionKey(k), String(k)).toBeNull();
  });
});

describe('attentionAmountCurrency', () => {
  it("uses the item's own currency when it has one, else the home currency", () => {
    expect(attentionAmountCurrency({ currency: 'EUR' }, 'USD')).toBe('EUR');
    expect(attentionAmountCurrency({ currency: null }, 'CAD')).toBe('CAD');
    expect(attentionAmountCurrency({}, 'GBP')).toBe('GBP');
    expect(attentionAmountCurrency(undefined, 'USD')).toBe('USD');
    // Garbage never reaches Intl.NumberFormat (which would throw on a bad code).
    expect(attentionAmountCurrency({ currency: 'euro' }, 'USD')).toBe('USD');
    expect(attentionAmountCurrency({ currency: 7 }, 'USD')).toBe('USD');
  });
});
