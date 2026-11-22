import { describe, expect, it } from 'vitest';
import { amountOf } from '@/lib/agent/facts';
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

  it('keeps the payroll item list a read (the read-only handle refuses its first-use write)', () => {
    expect(op('payroll-items.list')).toMatchObject({ class: 'read', dryRun: 'none' });
  });

  it('sizes a payroll adjustment by its lines, whatever its kind', () => {
    const enter = op('payroll.adjustments.create');
    expect(enter.amountField).toBe('lines.*.amount');
    // A liability adjustment answers grossPay 0; its lines hold the money.
    const body = {
      type: 'liability',
      employeeId: 'e1',
      date: '2026-11-20',
      lines: [
        { kind: 'tax', name: 'Federal Withholding', amount: '1200.00' },
        { kind: 'deduction', name: '401(k)', amount: '-300.00' },
      ],
    };
    expect(amountOf(enter, { body }, { grossPay: '0.00', lines: body.lines })).toBe('1500.00');
  });

  it('names no amount on a void whose answer has no figure right for every row', () => {
    // grossPay reads a liability adjustment as 0. After the dry run the bridge counts the entry the
    // void marks void, and a row that never posted one comes out 0.00: each why says so.
    expect(op('payroll.delete').amountField).toBeNull();
    expect(op('payroll.adjustments.delete').amountField).toBeNull();
    for (const id of ['payroll.delete', 'payroll.adjustments.delete']) {
      expect(op(id).why, id).toMatch(/the bridge counts the (?:paycheck's|adjustment's) entry/);
      expect(op(id).why, id).toMatch(/0\.00/);
    }
  });

  it('lets a reveal unmask the liability check memos the service masks', () => {
    // listPaymentChecks and voidPaymentCheck answer through paymentCheckFor (liabilityPayments.ts).
    expect(op('pay-liabilities.checks')).toMatchObject({ class: 'read', reveal: 'account_numbers', sensitiveFields: ['items.*.memo'] });
    expect(op('pay-liabilities.checks.action')).toMatchObject({ class: 'change', reveal: 'account_numbers', sensitiveFields: ['memo'] });
  });
});
