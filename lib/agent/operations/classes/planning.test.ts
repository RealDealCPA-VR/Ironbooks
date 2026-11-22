import { describe, expect, it } from 'vitest';
import { operationById } from '../registry';
import type { Operation } from '../types';
import { bucketProblems } from './check';
import { PLANNING_CLASSES } from './planning';

const op = (id: string): Operation => {
  const found = operationById(id);
  if (!found) throw new Error(`no operation ${id}`);
  return found;
};

describe('classification: planning', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('planning', PLANNING_CLASSES)).toEqual([]);
  });

  it('lets a reveal unmask a Sales Tax Payment memo, which every check answer masks', () => {
    const cases: Array<[string, string]> = [
      ['sales-tax.payments.create', 'checks.*.memo'],
      ['sales-tax.payments', 'items.*.memo'],
      ['sales-tax.payments.get', 'memo'],
      ['sales-tax.payments.action', 'memo'],
    ];
    for (const [id, field] of cases) {
      expect(op(id).reveal, id).toBe('account_numbers');
      expect(op(id).sensitiveFields, id).toContain(field);
    }
    // The class stays what the operation does: the masked answer is ordinary.
    expect(op('sales-tax.payments').class).toBe('read');
    expect(op('sales-tax.payments.create').class).toBe('enter');
  });
});
