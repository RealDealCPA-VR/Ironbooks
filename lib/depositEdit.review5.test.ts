/**
 * Review round 5 (team banking) — editing a saved deposit in the Make Deposits window.
 */
import { describe, it, expect } from 'vitest';
import { depositToEdit, itemsForDepositCurrency, type Deposit } from './depositEdit';

const dep = (currency: string | null): Deposit => ({
  id: 'd1',
  depositAccountId: 'bank-eur',
  accountName: 'EUR Checking',
  accountCode: '1020',
  date: '2026-03-10T00:00:00.000Z',
  total: '150.00',
  memo: 'March',
  voidedAt: null,
  createdAt: '2026-03-10T00:00:00.000Z',
  currency,
  lines: [
    { id: 'l1', depositId: 'd1', paymentId: 'p1', description: null, amount: '100.00' },
    { id: 'l2', depositId: 'd1', paymentId: null, description: 'invoicePayment:inv1', amount: '50.00' },
    { id: 'l3', depositId: 'd1', paymentId: null, description: 'Owner money', amount: '10.00', accountId: 'equity' },
  ],
});

describe('editing a saved deposit', () => {
  it('a foreign-currency deposit keeps its own payments in the picker (saving used to drop them)', () => {
    const edit = depositToEdit(dep('EUR'));
    const shown = itemsForDepositCurrency(edit.items, 'EUR');
    expect(shown.map((i) => i.id)).toEqual(['p1', 'inv1']);
  });

  it('a home-currency deposit still shows its payments', () => {
    const edit = depositToEdit(dep(null));
    expect(itemsForDepositCurrency(edit.items, null).map((i) => i.id)).toEqual(['p1', 'inv1']);
    expect(edit.extraLines).toEqual([{ accountId: 'equity', amount: '10.00', description: 'Owner money' }]);
  });
});
