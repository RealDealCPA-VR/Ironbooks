import { describe, expect, it } from 'vitest';
import { amountOf } from '@/lib/agent/facts';
import { decide, resolvePolicy } from '@/lib/agent/policy';
import { clampForAgent } from '@/lib/permissions/agentAccess';
import { fullAccess } from '@/lib/permissions/model';
import { operationById } from '../registry';
import type { Operation } from '../types';
import { bucketProblems } from './check';
import { PAYROLL_CLASSES } from './payroll';

const op = (id: string): Operation => {
  const found = operationById(id);
  if (!found) throw new Error(`no operation ${id}`);
  return found;
};

describe('classification: payroll', () => {
  it('covers every route of the bucket and is well formed', () => {
    expect(bucketProblems('payroll', PAYROLL_CLASSES)).toEqual([]);
  });

  it('reads the state wage worksheet masked, and reveals only the state account number', () => {
    // The service masks the employer's account number and never answers more than 4 SSN digits.
    expect(op('payroll.state-wage-worksheet')).toMatchObject({ class: 'read', reveal: 'account_numbers', sensitiveFields: ['accountNumber'] });
  });

  it('keeps the payroll item list a read (an agent\'s read never adds the standard items)', () => {
    expect(op('payroll-items.list')).toMatchObject({ class: 'read', dryRun: 'none' });
    expect(op('payroll-items.list').why).toMatch(/An agent's read never does/);
    expect(op('payroll-items.list').why).not.toMatch(/has no read-only guard/);
  });

  it('sizes a payroll adjustment by what it posts, never by its withholding counted twice', () => {
    const enter = op('payroll.adjustments.create');
    expect(enter.amountField).toBe('grossPay');
    // Year to date: 2000.00 of wages with 200.00 withheld from them. The entry (when it posts) debits
    // the 2000.00 of wages; adding up the lines said 2200.00. The bridge takes the larger of this
    // figure and the entry, so a posting adjustment is sized by its entry.
    const ytd = {
      type: 'ytd',
      employeeId: 'e1',
      date: '2026-01-31',
      lines: [
        { kind: 'earning', name: 'Salary', amount: '2000.00' },
        { kind: 'tax', name: 'Federal Withholding', amount: '200.00' },
      ],
    };
    expect(amountOf(enter, { body: ytd }, { grossPay: '2000.00', totalTaxes: '200.00', netPay: '1800.00', lines: ytd.lines })).toBe('2000.00');
    // Liability: grossPay is 0, so only its entry sizes it. One that posts no entry reads 0.00 though
    // its lines change the 941: a known gap no single answer field closes, which the why says.
    const liability = { type: 'liability', employeeId: 'e1', date: '2026-11-20', lines: [{ kind: 'tax', name: 'Federal Withholding', amount: '1200.00' }] };
    expect(amountOf(enter, { body: liability }, { grossPay: '0.00', totalTaxes: '1200.00', lines: liability.lines })).toBe('0.00');
    expect(enter.why).toMatch(/A liability adjustment that posts nothing[^.]*read 0\.00/);
    expect(enter.why).not.toMatch(/whose money is only in its entry/);
    // Before the route has answered, the body names no gross pay: unknown, over every limit.
    expect(amountOf(enter, { body: ytd })).toBeNull();
  });

  it('names no amount on a void whose answer has no figure right for every row', () => {
    // grossPay reads a liability adjustment as 0. After the dry run the bridge counts the entry the
    // void marks void; a row that never posted one keeps the amount unknown: each why says so.
    expect(op('payroll.delete').amountField).toBeNull();
    expect(op('payroll.adjustments.delete').amountField).toBeNull();
    for (const id of ['payroll.delete', 'payroll.adjustments.delete']) {
      expect(op(id).why, id).toMatch(/the bridge counts the (?:paycheck's|adjustment's) entry/);
      expect(op(id).why, id).toMatch(/unknown, not 0\.00/);
      expect(op(id).why, id).not.toMatch(/comes out 0\.00/);
    }
  });

  it('always asks before an adjustment is voided, by either route that voids one, as entering one does', () => {
    // voidPaycheck takes any payroll row, an adjustment too, so payroll.delete asks as well.
    for (const id of ['payroll.adjustments.create', 'payroll.adjustments.delete', 'payroll.delete']) {
      expect(op(id).alwaysAsk, id).toBe(true);
      const d = decide({
        access: clampForAgent(fullAccess()),
        policy: resolvePolicy('full_with_asks', []),
        operation: op(id),
        facts: { confirm: [], reveal: false, amount: '1.00', count: null, entityIds: [], accountIds: [], date: null, closedPeriod: false },
        grants: [],
        now: '2026-11-20T12:00:00.000Z',
      });
      expect(d.outcome, id).toBe('ask');
    }
  });

  it('lets a reveal unmask the liability check memos the service masks', () => {
    // listPaymentChecks and voidPaymentCheck answer through paymentCheckFor (liabilityPayments.ts).
    expect(op('pay-liabilities.checks')).toMatchObject({ class: 'read', reveal: 'account_numbers', sensitiveFields: ['items.*.memo'] });
    expect(op('pay-liabilities.checks.action')).toMatchObject({ class: 'change', reveal: 'account_numbers', sensitiveFields: ['memo'] });
  });
});
