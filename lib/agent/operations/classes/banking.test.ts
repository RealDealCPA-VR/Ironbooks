import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { describeRequest } from '@/lib/agent/describe';
import { amountOf } from '@/lib/agent/facts';
import { classRank, decide, resolvePolicy } from '@/lib/agent/policy';
import { clampForAgent } from '@/lib/permissions/agentAccess';
import { fullAccess } from '@/lib/permissions/model';
import { operationById, operationForRoute } from '../registry';
import { NEVER_ALLOW_CLASSES, type Operation, type RequestFacts, type RiskClass } from '../types';
import { bucketProblems } from './check';
import { BANKING_CLASSES, BANKING_CLASS_BY_INPUT } from './banking';

const routeSource = (pattern: string): string =>
  fs.readFileSync(path.join(process.cwd(), 'app', ...pattern.split('/').filter(Boolean), 'route.ts'), 'utf8');

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

describe('classification: banking, a request that does two kinds of work', () => {
  const entries = Object.entries(BANKING_CLASS_BY_INPUT);

  it('keeps each such operation at the strictest class its input can give (the policy reads one class)', () => {
    expect(entries.map(([key]) => key).sort()).toEqual(['GET /api/bank-transactions/suggestions', 'PATCH /api/reconciliations/[id]']);
    for (const [key, split] of entries) {
      const [method, pattern] = key.split(' ');
      const o = operationForRoute(method, pattern)!;
      const all: RiskClass[] = [...Object.values(split!.classes), split!.otherwise];
      const strictest = all.reduce((a, b) => (classRank(b) > classRank(a) ? b : a));
      expect(o.class, key).toBe(strictest);
    }
  });

  it('names every action the Reconcile window\'s PATCH carries out (read off the route)', () => {
    const src = routeSource('/api/reconciliations/[id]');
    const patch = src.slice(src.indexOf('export async function PATCH'));
    const acted = [...new Set([...patch.matchAll(/action === '(\w+)'/g)].map((m) => m[1]))].sort();
    const split = BANKING_CLASS_BY_INPUT['PATCH /api/reconciliations/[id]']!;
    expect(acted.length).toBeGreaterThan(0);
    expect(Object.keys(split.classes).sort()).toEqual(acted);
    // Ticking and the statement figures are prepare; what posts or completes is change.
    expect(split.classes).toEqual({ setClearedMany: 'prepare', toggleCleared: 'prepare', updateStatement: 'prepare', complete: 'change', adjustments: 'change' });
  });

  it('sends bank lines off this computer only with ai=1, as the suggestions route reads it', () => {
    const src = routeSource('/api/bank-transactions/suggestions');
    expect(src).toMatch(/searchParams\.get\('ai'\) === '1'/);
    expect(BANKING_CLASS_BY_INPUT['GET /api/bank-transactions/suggestions']).toEqual({ from: 'query', field: 'ai', classes: { '1': 'outside' }, otherwise: 'read' });
    expect(op('bank-transactions.suggestions')).toMatchObject({ class: 'outside', effects: ['network'], dryRun: 'none' });
    // With ai=1 the payee name can also go to the vendor web lookup (aiCategorizer.ts lookupVendor),
    // when the owner turned it on: the why names both things that leave the computer.
    expect(op('bank-transactions.suggestions').why).toMatch(/AI model/);
    expect(op('bank-transactions.suggestions').why).toMatch(/vendor lookup/);
  });

  it('keeps excluding a bank line a change: an excluded line leaves the review list, on text outsiders wrote', () => {
    const exclude = op('bank-transactions.exclude');
    expect(exclude.class).toBe('change');
    expect(exclude.why).toMatch(/leaves the review list/);
    expect(exclude.why).toMatch(/text outsiders wrote/);
    // Reconciling the account shows a real charge that was excluded, so the why must not say that
    // nothing ever does; nor that ticking a reconciliation line is prepare today (it is a change).
    expect(exclude.why).not.toMatch(/no later step shows a person/);
    expect(exclude.why).not.toMatch(/Ticking a reconciliation line is prepare/);
    expect(op('reconciliations.update').class).toBe('change');
    // Under the default preset a person is asked; prepare would have run it unasked.
    const d = decide({
      access: clampForAgent(fullAccess()),
      policy: resolvePolicy('ask_every_change', []),
      operation: op('bank-transactions.exclude'),
      facts: PLAIN,
      grants: [],
      now: '2026-11-20T12:00:00.000Z',
    });
    expect(d.outcome).toBe('ask');
  });
});
