import { describe, expect, it } from 'vitest';
import { describeRequest } from '@/lib/agent/describe';
import { operationById } from '../registry';
import type { Operation } from '../types';
import { bucketProblems } from './check';
import { SALES_CLASSES } from './sales';

const op = (id: string): Operation => {
  const found = operationById(id);
  if (!found) throw new Error(`no operation ${id}`);
  return found;
};

describe('classification: sales', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('sales', SALES_CLASSES)).toEqual([]);
  });

  it('names what an action door does, with or without its action', () => {
    const credit = op('credit-memos.action');
    expect(describeRequest(credit, { params: { id: 'cm1' }, body: {} })).toBe('Apply credit memo cm1 to an invoice, refund it, or unapply it');
    expect(describeRequest(credit, { params: { id: 'cm1' }, body: { action: 'refund' } })).toBe(
      'Apply credit memo cm1 to an invoice, refund it, or unapply it (action: refund)',
    );
    expect(describeRequest(op('income-tracker.actions'), { body: {} })).toBe('Email, queue or convert the selected Income Tracker rows');
  });

  it('lists the edit-only flags of a payment on its edits alone', () => {
    expect(op('payments.create').confirmFlags).toEqual([]);
    for (const id of ['payments.replace', 'payments.update']) {
      expect(op(id).confirmFlags, id).toEqual(expect.arrayContaining(['allowReconciledEdit', 'removeFromDeposit']));
    }
  });
});
