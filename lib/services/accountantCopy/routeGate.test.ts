/** Accountant's Copy route gate: which saves an accountant may make in the working copy. */
import { describe, it, expect } from 'vitest';
import { accountantCopyAllowsApi } from './routeGate';
import { accountantMayPost } from './guard';

describe("Accountant's Copy route gate", () => {
  it('allows the saves the changes file carries back, plus housekeeping', () => {
    for (const p of [
      '/api/journal-entries',
      '/api/journal-entries/abc/reverse',
      '/api/expenses/abc',
      '/api/accounts/abc',
      '/api/classes',
      '/api/accountant-copy/changes',
      '/api/auth/logout',
      '/api/preferences/my',
    ]) {
      expect(accountantCopyAllowsApi(p), p).toBe(true);
    }
  });

  it('refuses saves that could not be sent back to the client', () => {
    for (const p of ['/api/invoices', '/api/payments', '/api/bills/abc', '/api/customers', '/api/merge', '/api/preferences', '/api/accountant/reclassify', '/api/journal-entriesX']) {
      expect(accountantCopyAllowsApi(p), p).toBe(false);
    }
  });

  it('only General Journal entries, reversals and checks / expenses may post in the copy', () => {
    expect(accountantMayPost(null)).toBe(true);
    expect(accountantMayPost('manual')).toBe(true);
    expect(accountantMayPost('reversal:1')).toBe(true);
    expect(accountantMayPost('expense:1')).toBe(true);
    expect(accountantMayPost('invoice:1')).toBe(false);
    expect(accountantMayPost('payment:1')).toBe(false);
    expect(accountantMayPost('condense:1')).toBe(false);
  });
});
