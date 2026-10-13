/**
 * P1 setup: decision logic behind the app-wide Preferences (lib/prefBehaviors.ts) and the
 * API client write hooks that apply them (lib/client.ts setWriteHooks).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PREFERENCES, DEFAULT_MY_PREFERENCES } from './preferences';
import {
  autoDecimal,
  bodyDate,
  isMoneyField,
  isNewTransactionDateField,
  promptsBeforeSave,
  recordsTransaction,
  transactionTarget,
} from './prefBehaviors';
import { api, setWriteHooks, CANCELLED_CODE } from './client';

const company = DEFAULT_COMPANY_PREFERENCES; // warn past 90 days / future 30 days
const my = DEFAULT_MY_PREFERENCES; // warnWhenEditing on
const today = '2026-06-15';

describe('promptsBeforeSave', () => {
  it('warns about far past/future dates on forms that do not ask themselves', () => {
    const p = promptsBeforeSave({ method: 'POST', path: '/api/sales-receipts', body: { date: '2025-01-01' } }, company, my, today);
    expect(p.map((x) => x.kind)).toEqual(['date']);
    expect(p[0].message).toMatch(/more than 90 days in the past/);
    for (const path of ['/api/credit-memos', '/api/estimates', '/api/sales-orders', '/api/purchase-orders', '/api/deposits', '/api/transfers']) {
      expect(promptsBeforeSave({ method: 'POST', path, body: { date: '2026-12-31' } }, company, my, today)[0]?.kind, path).toBe('date');
    }
    // In range: nothing to ask.
    expect(promptsBeforeSave({ method: 'POST', path: '/api/deposits', body: { date: '2026-06-01' } }, company, my, today)).toEqual([]);
    // Forms that already ask (invoices, bills, checks, journal, payments) are not asked twice.
    expect(promptsBeforeSave({ method: 'POST', path: '/api/invoices', body: { date: '2020-01-01' } }, company, my, today)).toEqual([]);
    // Warnings off.
    expect(
      promptsBeforeSave({ method: 'POST', path: '/api/deposits', body: { date: '2020-01-01' } }, { ...company, warnPastDatesEnabled: false }, my, today),
    ).toEqual([]);
  });

  it('"Warn when editing a transaction" asks before saving changes to a recorded transaction', () => {
    const edit = promptsBeforeSave({ method: 'PUT', path: '/api/invoices/abc', body: { date: today, lines: [] } }, company, my, today);
    expect(edit.map((x) => x.kind)).toEqual(['edit']);
    expect(promptsBeforeSave({ method: 'PUT', path: '/api/invoices/abc', body: { lines: [] } }, company, { warnWhenEditing: false }, today)).toEqual([]);
    // New transactions, one-field status changes, sub-actions and non-transactions are not "edits".
    expect(promptsBeforeSave({ method: 'POST', path: '/api/invoices', body: { lines: [] } }, company, my, today)).toEqual([]);
    expect(promptsBeforeSave({ method: 'PATCH', path: '/api/estimates/abc', body: { status: 'accepted' } }, company, my, today)).toEqual([]);
    expect(promptsBeforeSave({ method: 'POST', path: '/api/invoices/abc/void', body: {} }, company, my, today)).toEqual([]);
    expect(promptsBeforeSave({ method: 'PATCH', path: '/api/customers/abc', body: { name: 'x' } }, company, my, today)).toEqual([]);
  });
});

describe('helpers', () => {
  it('transactionTarget / recordsTransaction / bodyDate', () => {
    expect(transactionTarget('/api/bills')).toEqual({ base: '/api/bills', record: false });
    expect(transactionTarget('/api/bills/1')).toEqual({ base: '/api/bills', record: true });
    expect(transactionTarget('/api/bills/1/void')).toBeNull();
    expect(transactionTarget('/api/bill-payments')).toEqual({ base: '/api/bill-payments', record: false });
    expect(transactionTarget('/api/payroll/pay-runs')).toEqual({ base: '/api/payroll/pay-runs', record: false });
    expect(transactionTarget('/api/payroll')).toEqual({ base: '/api/payroll', record: false });
    expect(recordsTransaction({ method: 'POST', path: '/api/deposits' })).toBe(true);
    expect(recordsTransaction({ method: 'PUT', path: '/api/deposits/1' })).toBe(true);
    expect(recordsTransaction({ method: 'DELETE', path: '/api/deposits/1' })).toBe(false);
    expect(recordsTransaction({ method: 'POST', path: '/api/customers' })).toBe(false);
    expect(bodyDate({ date: '2026-01-02T00:00:00Z' })).toBe('2026-01-02');
    expect(bodyDate({ memo: 'x' })).toBeNull();
  });

  it('nextJournalNumber continues the highest Entry No.', async () => {
    const { nextJournalNumber } = await import('./prefBehaviors');
    expect(nextJournalNumber([])).toBe('1');
    expect(nextJournalNumber(['7', null, '12', 'REV of #40'])).toBe('13');
    expect(nextJournalNumber(['GJ-0099', 'memo'])).toBe('GJ-0100');
  });

  it('paychecks get the date warning (payDate)', () => {
    expect(promptsBeforeSave({ method: 'POST', path: '/api/payroll', body: { payDate: '2020-01-01' } }, company, my, today)[0]?.kind).toBe('date');
    expect(promptsBeforeSave({ method: 'POST', path: '/api/payroll/pay-runs', body: { payDate: '2020-01-01' } }, company, my, today)[0]?.kind).toBe('date');
  });

  it('autoDecimal places the decimal point like QB (typing 1234 enters 12.34)', () => {
    expect(autoDecimal('1234')).toBe('12.34');
    expect(autoDecimal('5')).toBe('0.05');
    expect(autoDecimal('100')).toBe('1.00');
    expect(autoDecimal('-250')).toBe('-2.50');
    expect(autoDecimal('12.5')).toBe('12.5'); // already has a point: unchanged
    expect(autoDecimal('3*4')).toBe('3*4'); // math expression: left to the calculator
    expect(autoDecimal('')).toBe('');
  });

  it('only amount fields get the automatic decimal point; only transaction dates get the remembered date', () => {
    expect(isMoneyField({ placeholder: 'Rate' })).toBe(true);
    expect(isMoneyField({ placeholder: 'Qty' })).toBe(false);
    expect(isMoneyField({ ariaLabel: 'Hours' })).toBe(false);
    expect(isNewTransactionDateField({ labelText: 'Date' })).toBe(true);
    expect(isNewTransactionDateField({ labelText: 'Due date' })).toBe(false);
    expect(isNewTransactionDateField({ id: 'filter-from' })).toBe(false);
    expect(isNewTransactionDateField({ labelText: 'Ship date' })).toBe(false);
  });
});

describe('API client write hooks', () => {
  afterEach(() => {
    setWriteHooks(null);
    vi.unstubAllGlobals();
  });

  it('a hook can cancel a save (nothing is sent) and runs after a successful save', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const after = vi.fn();
    setWriteHooks({ before: () => false, after });
    await expect(api.post('/api/deposits', { date: '2020-01-01' })).rejects.toMatchObject({ code: CANCELLED_CODE });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();

    setWriteHooks({ before: () => true, after });
    await api.post('/api/deposits', { date: '2026-06-01' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ method: 'POST', path: '/api/deposits', body: { date: '2026-06-01' } }, { id: '1' });
  });
});
