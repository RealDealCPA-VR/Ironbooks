/**
 * Review round 5 — Preferences that apply to every transaction (lib/prefBehaviors.ts):
 * "Warn if transactions are N days in the past / future", "Beep when recording a transaction" and
 * "When report data changes: refresh" were skipped for transactions saved outside the classic forms
 * (each case failed before the fix):
 *  - a transaction typed into an account register's blank row (POST /api/registers/<accountId> —
 *    a NEW check / deposit / transfer / journal entry, not an edit of the register);
 *  - a statement charge typed into the customer register (POST /api/invoices/statement-charges,
 *    which was taken for an edit of an invoice named "statement-charges");
 *  - a Working Trial Balance adjusting entry and a Sales Tax Adjustment.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PREFERENCES, DEFAULT_MY_PREFERENCES } from './preferences';
import { promptsBeforeSave, recordsTransaction, transactionTarget } from './prefBehaviors';

const company = DEFAULT_COMPANY_PREFERENCES; // warn past 90 days / future 30 days
const my = DEFAULT_MY_PREFERENCES;
const today = '2026-06-15';
const ACCOUNT = '0b6c3f0e-3f7b-4b7e-9d1e-2b8a4f6c9d10';

describe('date warnings and after-save behaviour cover every way a transaction is entered', () => {
  it('a register entry dated two years ago asks first, and counts as a recorded transaction', () => {
    const info = { method: 'POST', path: `/api/registers/${ACCOUNT}`, body: { date: '2024-06-01', side: 'decrease', amount: '10.00' } };
    expect(promptsBeforeSave(info, company, my, today).map((p) => p.kind)).toEqual(['date']);
    expect(recordsTransaction(info)).toBe(true);
    expect(transactionTarget(info.path)).toEqual({ base: '/api/registers', record: false });
    // A register entry dated today: nothing to ask. Reading the register is not a save.
    expect(promptsBeforeSave({ ...info, body: { ...info.body, date: today } }, company, my, today)).toEqual([]);
  });

  it('statement charges: entering one is a create (date warning), changing one is an edit', () => {
    const create = { method: 'POST', path: '/api/invoices/statement-charges', body: { customerId: ACCOUNT, date: '2027-01-15', amount: '5' } };
    expect(promptsBeforeSave(create, company, my, today).map((p) => p.kind)).toEqual(['date']);
    expect(recordsTransaction(create)).toBe(true);
    const edit = { method: 'PUT', path: `/api/invoices/statement-charges/${ACCOUNT}`, body: { date: today, amount: '6' } };
    expect(promptsBeforeSave(edit, company, my, today).map((p) => p.kind)).toEqual(['edit']);
    // Invoices themselves are unchanged (their form asks about dates itself).
    expect(transactionTarget('/api/invoices')).toEqual({ base: '/api/invoices', record: false });
    expect(transactionTarget(`/api/invoices/${ACCOUNT}`)).toEqual({ base: '/api/invoices', record: true });
  });

  it('Working Trial Balance adjusting entries and Sales Tax Adjustments get the date warning', () => {
    for (const path of ['/api/accountant/working-trial-balance', '/api/accountant/sales-tax/adjustments']) {
      const info = { method: 'POST', path, body: { date: '2020-12-31', description: 'x' } };
      expect(promptsBeforeSave(info, company, my, today)[0]?.kind, path).toBe('date');
      expect(recordsTransaction(info), path).toBe(true);
    }
    // Saving a workpaper note (PUT) is not a transaction.
    expect(promptsBeforeSave({ method: 'PUT', path: '/api/accountant/working-trial-balance', body: { accountId: ACCOUNT, periodEnd: '2020-12-31' } }, company, my, today)).toEqual([]);
    expect(recordsTransaction({ method: 'PUT', path: '/api/accountant/working-trial-balance' })).toBe(false);
  });
});
