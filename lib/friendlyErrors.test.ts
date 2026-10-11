/**
 * Unit tests for lib/friendlyErrors.ts — the plain-language error layer behind toastError.
 * Every ServiceError code must produce a headline + a "what to do next" step, keep the
 * server's specific message (except INTERNAL), and fall back to the HTTP status when the
 * response carried no code.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/client';
import {
  codeFromStatus,
  describeError,
  friendlyErrorText,
  humanizeFieldMessage,
} from './friendlyErrors';

describe('describeError — ServiceError codes', () => {
  it('UNBALANCED explains debits = credits and how to fix it', () => {
    const f = describeError(new ApiError(400, 'Journal entry is unbalanced: debits 100.00 != credits 90.00', 'UNBALANCED'));
    expect(f.code).toBe('UNBALANCED');
    expect(f.title).toMatch(/debits and credits/i);
    expect(f.message).toContain('debits 100.00');
    expect(f.nextStep).toMatch(/difference is 0\.00/);
  });

  it('PERIOD_CLOSED points at the closing date and the password', () => {
    const f = describeError(new ApiError(400, 'Date 2024-01-05 is on or before the closing date', 'PERIOD_CLOSED'));
    expect(f.title).toMatch(/closed period/i);
    expect(f.nextStep).toMatch(/closing date/i);
    expect(f.nextStep).toMatch(/password/i);
  });

  it('PERIOD_CLOSED is recognized even when a route maps it to 500', () => {
    const f = describeError(new ApiError(500, 'Period closed', 'PERIOD_CLOSED'));
    expect(f.code).toBe('PERIOD_CLOSED');
  });

  it('FORBIDDEN tells the user who can grant access', () => {
    const f = describeError(new ApiError(403, 'Your role is view-only. This action requires write access.', 'FORBIDDEN'));
    expect(f.title).toMatch(/permission/i);
    expect(f.message).toMatch(/view-only/);
    expect(f.nextStep).toMatch(/owner or an admin/i);
  });

  it('CONFLICT keeps the specific reason and suggests refresh / undo linked items', () => {
    const f = describeError(new ApiError(409, 'Invoice has payments applied; void the payments first.', 'CONFLICT'));
    expect(f.message).toContain('payments applied');
    expect(f.nextStep).toMatch(/refresh/i);
  });

  it('VALIDATION humanizes zod field paths', () => {
    const f = describeError(new ApiError(400, 'lines.0.debit: must be a decimal amount', 'VALIDATION'));
    expect(f.title).toMatch(/needs fixing/i);
    expect(f.message).toBe('Line 1 debit: must be a decimal amount');
    expect(f.nextStep).toMatch(/\*/);
  });

  it('NOT_FOUND suggests refreshing', () => {
    const f = describeError(new ApiError(404, 'Invoice not found', 'NOT_FOUND'));
    expect(f.message).toBe('Invoice not found');
    expect(f.nextStep).toMatch(/refresh/i);
  });

  it('INTERNAL never shows the raw server text', () => {
    const f = describeError(new ApiError(500, 'TypeError: cannot read x of undefined', 'INTERNAL'), 'Failed to save invoice.');
    expect(f.message).not.toMatch(/TypeError/);
    expect(f.message).toContain('Failed to save invoice.');
    expect(f.nextStep).toMatch(/Data Integrity/);
  });
});

describe('describeError — fallbacks', () => {
  it('infers the code from status when the body had none', () => {
    expect(describeError(new ApiError(409, 'Duplicate number')).code).toBe('CONFLICT');
    expect(describeError(new ApiError(404, 'Not Found')).code).toBe('NOT_FOUND');
    expect(describeError(new ApiError(503, 'Service Unavailable')).code).toBe('INTERNAL');
  });

  it('ignores unknown codes and uses the status', () => {
    expect(describeError(new ApiError(400, 'bad', 'WEIRD')).code).toBe('VALIDATION');
  });

  it('recognizes the locked-company-file 403', () => {
    const f = describeError(new ApiError(403, 'This company file is locked. Unlock it to continue.'));
    expect(f.code).toBe('FILE_LOCKED');
    expect(f.nextStep).toMatch(/password/i);
  });

  it('maps fetch network failures', () => {
    const f = describeError(new TypeError('Failed to fetch'));
    expect(f.code).toBe('NETWORK');
    expect(f.message).toMatch(/nothing was saved/i);
  });

  it('handles plain Errors and non-errors', () => {
    expect(describeError(new Error('boom')).message).toBe('boom');
    expect(describeError('weird', 'Failed to load.').message).toBe('Failed to load.');
    expect(describeError(null).title).toMatch(/went wrong/i);
  });

  it('ApiError.friendly exposes the same mapping without changing message', () => {
    const e = new ApiError(400, 'Period is closed', 'PERIOD_CLOSED');
    expect(e.message).toBe('Period is closed');
    expect(e.friendly.code).toBe('PERIOD_CLOSED');
    expect(e.friendly.nextStep).toMatch(/closing date/i);
  });

  it('friendlyErrorText joins message and next step', () => {
    const t = friendlyErrorText(new ApiError(404, 'Bill not found', 'NOT_FOUND'));
    expect(t.startsWith('Bill not found ')).toBe(true);
    expect(t).toMatch(/refresh/i);
  });
});

describe('helpers', () => {
  it('codeFromStatus', () => {
    expect(codeFromStatus(400)).toBe('VALIDATION');
    expect(codeFromStatus(401)).toBe('FORBIDDEN');
    expect(codeFromStatus(200)).toBeUndefined();
  });

  it('humanizeFieldMessage', () => {
    expect(humanizeFieldMessage('customerId: Required')).toBe('Customer: Required');
    expect(humanizeFieldMessage('lines.2.accountId: must be a valid id')).toBe('Line 3 account: must be a valid id');
    expect(humanizeFieldMessage('Invoice not found')).toBe('Invoice not found');
  });
});
