import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeRequest } from '@/lib/agent/describe';
import { amountOf } from '@/lib/agent/facts';
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

  it('judges a Receive Payments save by the credits it applies, not only the cash', () => {
    const pay = op('payments.create');
    expect(pay.amountField).toBe('creditsApplied');
    // receivePayment answers { payment, entry, creditsApplied }: a $1 payment applying a $50,000 credit.
    const answer = { payment: { id: 'p1', amount: '1.00' }, entry: { id: 'e1' }, creditsApplied: '50000.00' };
    expect(amountOf(pay, { body: { customerId: 'c1', amount: '1.00', applications: [] } }, answer)).toBe('50000.00');
    // Only earlier payments used: no payment is recorded, the credits still size it.
    expect(amountOf(pay, { body: {} }, { payment: { id: 'p0' }, entry: null, creditsApplied: '300.00' })).toBe('300.00');
    // Before the route has answered, nothing in the body gives the figure: unknown, over every limit.
    expect(amountOf(pay, { body: { customerId: 'c1', amount: '1.00' } })).toBeNull();
  });

  it('judges an edit of a received payment by the credits it applies, as receiving one', () => {
    // updatePayment answers { payment, entry, creditsApplied } like receivePayment (the edit applies
    // earlier payments and other credits again). PUT and PATCH are one handler.
    for (const id of ['payments.replace', 'payments.update']) {
      const edit = op(id);
      expect(edit.amountField, id).toBe('creditsApplied');
      const answer = { payment: { id: 'p1', amount: '1.00' }, entry: { id: 'e2' }, creditsApplied: '50000.00' };
      expect(amountOf(edit, { params: { id: 'p1' }, body: { customerId: 'c1', amount: '1.00', applications: [] } }, answer), id).toBe('50000.00');
      // A figure the agent types in the body cannot lower it: the larger of body and answer wins.
      expect(amountOf(edit, { params: { id: 'p1' }, body: { creditsApplied: '0.00' } }, answer), id).toBe('50000.00');
      // Before the route has answered: unknown, over every limit. The bridge then also weighs the
      // entry the edit voids and the one it posts (the cash), and takes the larger.
      expect(amountOf(edit, { params: { id: 'p1' }, body: { customerId: 'c1', amount: '1.00' } }), id).toBeNull();
      expect(edit.why, id).toMatch(/creditsApplied/);
    }
    // The figure is there to read: updatePayment answers it (lib/services/payments.ts).
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/services/payments.ts'), 'utf8');
    const start = src.indexOf('export async function updatePayment(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nexport ', start + 1);
    expect(src.slice(start, end === -1 ? undefined : end)).toMatch(/creditsApplied:/);
  });

  it('names the preview option of the bulk customer save', () => {
    expect(op('customers.bulk.save')).toMatchObject({ dryRun: 'preview', countField: 'rows' });
    expect(op('customers.bulk.save').why).toMatch(/dryRun: true/);
  });

  it('lists the edit-only flags of a payment on its edits alone', () => {
    expect(op('payments.create').confirmFlags).toEqual([]);
    for (const id of ['payments.replace', 'payments.update']) {
      expect(op(id).confirmFlags, id).toEqual(expect.arrayContaining(['allowReconciledEdit', 'removeFromDeposit']));
    }
  });
});
