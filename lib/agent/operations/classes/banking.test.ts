import { describe, expect, it } from 'vitest';
import { describeRequest } from '@/lib/agent/describe';
import { amountOf } from '@/lib/agent/facts';
import { decide, resolvePolicy } from '@/lib/agent/policy';
import { clampForAgent } from '@/lib/permissions/agentAccess';
import { fullAccess } from '@/lib/permissions/model';
import { operationById } from '../registry';
import { NEVER_ALLOW_CLASSES, type Operation, type RequestFacts } from '../types';
import { bucketProblems } from './check';
import { BANKING_CLASSES } from './banking';

const op = (id: string): Operation => {
  const found = operationById(id);
  if (!found) throw new Error(`no operation ${id}`);
  return found;
};

const PLAIN: RequestFacts = { confirm: [], reveal: false, amount: null, count: null, entityIds: [], accountIds: [], date: null, closedPeriod: false };

describe('classification: banking', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('banking', BANKING_CLASSES)).toEqual([]);
  });

  it('protects the check PDF, which prints the full account number for every caller', () => {
    const pdf = op('checks.pdf');
    expect(pdf).toMatchObject({ class: 'read_sensitive', reveal: 'account_numbers', output: 'pdf', dryRun: 'none' });
    expect(NEVER_ALLOW_CLASSES).toContain(pdf.class);
    // Even the widest preset asks, and the approver needs "view full account numbers".
    const d = decide({
      access: clampForAgent(fullAccess()),
      policy: resolvePolicy('full_with_asks', []),
      operation: pdf,
      facts: PLAIN,
      grants: [],
      now: '2026-11-20T12:00:00.000Z',
    });
    expect(d.outcome).toBe('ask');
    if (d.outcome === 'ask') expect(d.needs.flags ?? [d.needs.flag]).toContain('fullAccountNumbers');
  });

  it('lets a reveal unmask the print queue memos the service masks', () => {
    expect(op('print-queue.list')).toMatchObject({ class: 'read', reveal: 'account_numbers' });
    expect(op('print-queue.mark-printed')).toMatchObject({ class: 'print', reveal: 'account_numbers' });
    // A queued refund check answers through paymentCheckFor (liabilityPayments.ts): its memo is masked.
    expect(op('print-queue.refunds.add')).toMatchObject({ class: 'enter', reveal: 'account_numbers', sensitiveFields: ['memo'] });
  });

  it('names the kind of check in the print queue lines as an aside, never as a word of the sentence', () => {
    expect(describeRequest(op('print-queue.mark-printed'), { body: { source: 'bill_payment', id: 'c1', checkNumber: '1043' } })).toBe(
      'Record check c1 (kind: bill_payment) as printed with check number 1043',
    );
    expect(describeRequest(op('print-queue.reprint'), { body: { id: 'c1' } })).toBe('Put printed check c1 back in the print queue to print again');
  });

  it('sizes a void after its dry run by the entry it voids; an amountField only raises that figure', () => {
    // A journal entry or register void answers no figure: no amountField. Until the dry run the amount
    // is unknown; after it the bridge counts the entry the run voided (or deleted) at its total.
    expect(op('journal-entries.delete').amountField).toBeNull();
    expect(op('registers.delete').amountField).toBeNull();
    for (const id of ['journal-entries.delete', 'registers.delete']) expect(op(id).why, id).toMatch(/bridge counts the entry the run voided/);
    // Undoing a categorization voids the entry the line made: the line's own amount is the floor.
    const unmatch = op('bank-transactions.unmatch');
    expect(unmatch.amountField).toBe('amount');
    expect(amountOf(unmatch, { body: { bankTransactionId: 'b1' } }, { id: 'b1', amount: '-4250.00', matched: false })).toBe('-4250.00');
  });
});
