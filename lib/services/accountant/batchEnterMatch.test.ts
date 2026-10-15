/**
 * Enter Batch Transactions — name / account matching and per-row validation (pure; the grid and
 * the service share these rules).
 */
import { describe, it, expect } from 'vitest';
import { closestLabel, createBatchMatchers, editDistance, messagesByRow, resolveBatchRows, type BatchLookupLists } from './batchEnterMatch';

const lists: BatchLookupLists = {
  accounts: [
    { id: 'a1000', code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' },
    { id: 'a1200', code: '1200', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' },
    { id: 'a2000', code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'accounts_payable' },
    { id: 'a2100', code: '2100', name: 'Visa', type: 'liability', subtype: 'credit_card' },
    { id: 'a3000', code: '3000', name: "Owner's Equity", type: 'equity', subtype: null },
    { id: 'a4100', code: '4100', name: 'Service Income', type: 'income', subtype: null },
    { id: 'a6300', code: '6300', name: 'Office Supplies', type: 'expense', subtype: null },
    { id: 'a6600', code: '6600', name: 'Utilities', type: 'expense', subtype: null },
  ],
  customers: [
    { id: 'c1', name: 'Slow Payer' },
    { id: 'c2', name: 'Twin Name' },
    { id: 'c3', name: 'Twin Name' },
  ],
  vendors: [
    { id: 'v1', name: 'Office Depot' },
    { id: 'v2', name: 'City Power' },
  ],
  classes: [{ id: 'k1', name: 'Admin' }],
};
const M = createBatchMatchers(lists);

describe('createBatchMatchers', () => {
  it('matches accounts by number, name, "number · name" and "number name"', () => {
    expect(M.account('6300')).toBe('a6300');
    expect(M.account('office supplies')).toBe('a6300');
    expect(M.account('6300 · Office Supplies')).toBe('a6300');
    expect(M.account('6300 Office Supplies')).toBe('a6300');
    expect(M.account('6300 - Office Supplies')).toBe('a6300');
    expect(M.account('9999')).toBeNull();
    expect(M.account('')).toBeNull();
  });

  it('matches names case- and space-insensitively; duplicate names are ambiguous', () => {
    expect(M.vendor('  office   DEPOT ')).toBe('v1');
    expect(M.customer('slow payer')).toBe('c1');
    expect(M.customer('Twin Name')).toBeNull();
    expect(M.className('admin')).toBe('k1');
  });

  it('suggests the closest existing entry', () => {
    expect(M.suggest('account', 'Ofice Suplies')).toBe('6300 · Office Supplies');
    expect(M.suggest('vendor', 'Office Depo')).toBe('Office Depot');
    expect(M.suggest('vendor', 'Completely Different')).toBeNull();
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(closestLabel('util', ['Utilities', 'Rent'])).toBe('Utilities');
  });

  it('knows A/R and A/P control accounts', () => {
    expect(M.controlSide('a1200')).toBe('ar');
    expect(M.controlSide('a2000')).toBe('ap');
    expect(M.controlSide('a6300')).toBeNull();
  });
});

describe('resolveBatchRows', () => {
  it('checks: resolves good rows, reports each bad row with a reason', () => {
    const jobs = resolveBatchRows(
      {
        type: 'check',
        bankAccountId: 'a1000',
        rows: [
          { date: '3/5/2026', ref: '1001', name: 'Office Depot', account: '6300', amount: '$1,234.50', memo: 'Toner', className: 'Admin' },
          { date: '2026-03-06', name: 'Walk-in Payee', account: 'Utilities', amount: '20' },
          { date: '2026-02-30', name: 'Office Depot', account: 'Ofice Supplies', amount: 'abc' },
          { date: '2026-03-07', name: '', account: '6300', amount: '0' },
          { date: '2026-03-07', name: 'Office Depot', account: '1000', amount: '5' },
        ],
      },
      M,
    );
    expect(jobs).toHaveLength(5);
    expect(jobs[0].errors).toEqual([]);
    expect(jobs[0].doc).toEqual({
      kind: 'expense',
      type: 'check',
      date: '2026-03-05',
      vendorId: 'v1',
      payeeName: null,
      ref: '1001',
      memo: 'Toner',
      accountId: 'a6300',
      amount: '1234.50',
      classId: 'k1',
    });
    // Unknown payee: still fine (one-time payee), with a note.
    expect(jobs[1].errors).toEqual([]);
    expect(jobs[1].doc).toMatchObject({ vendorId: null, payeeName: 'Walk-in Payee', accountId: 'a6600' });
    expect(jobs[1].warnings[0]).toMatch(/one-time payee/);
    // Bad date, unknown account (with a suggestion), bad amount.
    expect(jobs[2].doc).toBeUndefined();
    expect(jobs[2].errors.join(' ')).toMatch(/date "2026-02-30" is not a valid date/);
    expect(jobs[2].errors.join(' ')).toMatch(/account "Ofice Supplies" was not found\. Did you mean "6300 · Office Supplies"\?/);
    expect(jobs[2].errors.join(' ')).toMatch(/amount "abc" is not a number/);
    expect(jobs[3].errors.join(' ')).toMatch(/amount must be greater than zero/);
    expect(jobs[3].errors.join(' ')).toMatch(/enter a payee name/);
    // The expense account can't be the bank account itself.
    expect(jobs[4].errors.join(' ')).toMatch(/can't be the same as the bank account/);
  });

  it('needs the bank / card account for checks, deposits and card charges', () => {
    const [j] = resolveBatchRows({ type: 'cc_charge', rows: [{ date: '2026-03-05', name: 'Office Depot', account: '6300', amount: '5' }] }, M);
    expect(j.errors.join(' ')).toMatch(/choose the credit card account first/);
  });

  it('bills and invoices need a vendor / customer from the lists; bill due date cannot precede the date', () => {
    const bills = resolveBatchRows(
      {
        type: 'bill',
        rows: [
          { date: '2026-03-08', ref: 'B-1', name: 'City Power', account: '6600', amount: '99.99', dueDate: '4/7/2026' },
          { date: '2026-03-08', name: 'City Powr', account: '6600', amount: '1' },
          { date: '2026-03-08', name: 'City Power', account: '6600', amount: '1', dueDate: '2026-03-01' },
        ],
      },
      M,
    );
    expect(bills[0].doc).toMatchObject({ kind: 'bill', vendorId: 'v2', ref: 'B-1', dueDate: '2026-04-07', amount: '99.99' });
    expect(bills[1].errors[0]).toMatch(/vendor "City Powr" was not found .*Did you mean "City Power"/);
    expect(bills[2].errors[0]).toMatch(/due date is before the bill date/);

    const invs = resolveBatchRows({ type: 'invoice', rows: [{ date: '2026-03-09', name: 'Twin Name', account: '4100', amount: '5' }] }, M);
    expect(invs[0].errors[0]).toMatch(/customer "Twin Name" was not found/);
  });

  it('journal entries group rows by date + ref, need two balanced lines, and A/R lines need a customer', () => {
    const jobs = resolveBatchRows(
      {
        type: 'journal',
        rows: [
          { date: '2026-03-10', ref: 'J1', account: '6600', debit: '10', memo: 'Accrual' },
          { date: '', ref: '', name: 'Office Depot', account: '2000', credit: '10' },
          { date: '2026-03-11', ref: 'J2', account: '6300', debit: '5' },
          { date: '2026-03-11', ref: 'J2', account: '1000', credit: '4' },
          { date: '2026-03-12', ref: 'J3', account: '1200', debit: '3' },
          { date: '2026-03-12', ref: 'J3', account: '4100', credit: '3' },
        ],
      },
      M,
    );
    expect(jobs.map((j) => j.rows)).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(jobs[0].doc).toMatchObject({
      kind: 'journal',
      date: '2026-03-10',
      reference: 'J1',
      description: 'Accrual',
      lines: [
        { accountId: 'a6600', debit: '10', credit: null },
        { accountId: 'a2000', debit: null, credit: '10', entityType: 'vendor', entityId: 'v1' },
      ],
    });
    expect(jobs[1].errors.join(' ')).toMatch(/debits \(5\.00\) and credits \(4\.00\) must be equal/);
    expect(jobs[2].errors.join(' ')).toMatch(/Accounts Receivable line needs a customer/);

    const by = messagesByRow(jobs);
    expect(by.get(3)?.errors).toBe(jobs[1].errors);
    expect(by.get(0)?.errors).toEqual([]);
  });

  it('warns about rows dated on or before the closing date (saving then needs the password)', () => {
    const jobs = resolveBatchRows(
      {
        type: 'deposit',
        bankAccountId: 'a1000',
        rows: [
          { date: '2026-01-15', name: 'Owner', account: '3000', amount: '100' },
          { date: '2026-02-15', name: 'Owner', account: '3000', amount: '100' },
        ],
      },
      M,
      { closingDate: '2026-01-31' },
    );
    expect(jobs[0].warnings[0]).toMatch(/closing date \(2026-01-31\)/);
    expect(jobs[1].warnings).toEqual([]);
    expect(jobs[0].doc).toMatchObject({ kind: 'deposit', accountId: 'a3000', amount: '100', description: 'Owner' });
  });
});
