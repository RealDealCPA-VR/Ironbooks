/**
 * Pure tests for the QuickBooks account-type model (lib/accountTypes.ts) and income-tax lines
 * (lib/taxLines.ts). No database.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SUBTYPES,
  QB_ACCOUNT_TYPES,
  isAccountsPayable,
  isBankAccount,
  isCashAccount,
  isCurrentAsset,
  isCurrentLiability,
  isDepositTargetAccount,
  isPaymentSourceAccount,
  qbAccountTypeOf,
  resolveQbAccountType,
} from './accountTypes';
import { INCOME_TAX_FORMS, TAX_LINES, getTaxLine, taxLinesForForm } from './taxLines';
import { accountSubtypeEnum } from './db/schema';

describe('QuickBooks account types', () => {
  it('covers the full QB Desktop account-type list in QB order', () => {
    expect(QB_ACCOUNT_TYPES.map((t) => t.label)).toEqual([
      'Bank',
      'Accounts Receivable',
      'Other Current Asset',
      'Fixed Asset',
      'Other Asset',
      'Accounts Payable',
      'Credit Card',
      'Other Current Liability',
      'Long Term Liability',
      'Equity',
      'Income',
      'Cost of Goods Sold',
      'Expense',
      'Other Income',
      'Other Expense',
      'Non-Posting',
    ]);
  });

  it('every subtype belongs to exactly one QB type and matches the DB enum', () => {
    expect([...ACCOUNT_SUBTYPES].sort()).toEqual([...accountSubtypeEnum.enumValues].sort());
    const seen = new Map<string, string>();
    for (const t of QB_ACCOUNT_TYPES) {
      expect(t.subtypes).toContain(t.defaultSubtype);
      for (const s of t.subtypes) {
        expect(seen.get(s), `${s} in ${t.value} and ${seen.get(s)}`).toBeUndefined();
        seen.set(s, t.value);
      }
      expect(t.help.length).toBeGreaterThan(20);
    }
    expect([...seen.keys()].sort()).toEqual([...ACCOUNT_SUBTYPES].sort());
  });

  it('derives the QB type from (type, subtype) with safe fallbacks for legacy combos', () => {
    expect(qbAccountTypeOf({ type: 'asset', subtype: 'checking' })).toBe('bank');
    expect(qbAccountTypeOf({ type: 'asset', subtype: 'undeposited_funds' })).toBe('other_current_asset');
    expect(qbAccountTypeOf({ type: 'asset', subtype: 'inventory' })).toBe('other_current_asset');
    expect(qbAccountTypeOf({ type: 'liability', subtype: 'other_current_liability' })).toBe('other_current_liability');
    expect(qbAccountTypeOf({ type: 'revenue', subtype: 'other_income' })).toBe('other_income');
    expect(qbAccountTypeOf({ type: 'expense', subtype: 'cost_of_goods_sold' })).toBe('cost_of_goods_sold');
    expect(qbAccountTypeOf({ type: 'expense', subtype: 'payroll' })).toBe('expense');
    expect(qbAccountTypeOf({ type: 'asset', subtype: 'non_posting' })).toBe('non_posting');
    // mismatched legacy data
    expect(qbAccountTypeOf({ type: 'expense', subtype: 'checking' })).toBe('expense');
    expect(qbAccountTypeOf({ type: 'liability', subtype: null })).toBe('other_current_liability');
    expect(resolveQbAccountType('bank', 'savings')).toEqual({ type: 'asset', subtype: 'savings' });
    expect(resolveQbAccountType('bank', 'credit_card')).toEqual({ type: 'asset', subtype: 'checking' });
  });

  it('classifies cash, bank, A/P, current vs long-term consistently', () => {
    const uf = { type: 'asset', subtype: 'undeposited_funds' };
    const prepaid = { type: 'asset', subtype: 'other_current_asset' };
    const ocl = { type: 'liability', subtype: 'other_current_liability' };
    const card = { type: 'liability', subtype: 'credit_card' };
    expect(isCashAccount(uf)).toBe(true);
    expect(isBankAccount(uf)).toBe(false);
    expect(isCashAccount(prepaid)).toBe(false);
    expect(isAccountsPayable(ocl)).toBe(false);
    expect(isCurrentLiability(ocl)).toBe(true);
    expect(isCurrentLiability({ type: 'liability', subtype: 'long_term_liability' })).toBe(false);
    expect(isCurrentAsset({ type: 'asset', subtype: 'fixed_assets' })).toBe(false);
    expect(isCurrentAsset({ type: 'asset', subtype: 'other_asset' })).toBe(false);
    expect(isCurrentAsset(prepaid)).toBe(true);
    expect(isPaymentSourceAccount(card)).toBe(true);
    expect(isPaymentSourceAccount(uf)).toBe(false);
    expect(isDepositTargetAccount(uf)).toBe(true);
    expect(isDepositTargetAccount({ type: 'asset', subtype: 'accounts_receivable' })).toBe(false);
    expect(isDepositTargetAccount({ type: 'asset', subtype: 'non_posting' })).toBe(false);
  });
});

describe('income-tax lines', () => {
  it('has unique keys and lines for every supported form', () => {
    const keys = TAX_LINES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of INCOME_TAX_FORMS) expect(taxLinesForForm(f.value).length).toBeGreaterThan(10);
    expect(getTaxLine('SCHC:8')?.label).toBe('Advertising');
    expect(getTaxLine('1120S:7')?.label).toBe('Compensation of officers');
    expect(getTaxLine('nope')).toBeUndefined();
  });
});
