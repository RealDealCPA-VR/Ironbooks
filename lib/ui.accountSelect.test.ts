/**
 * "Account Not Found — Set Up" on the transaction forms (components/AccountSelect.tsx).
 *
 * Office feedback: on Write Checks, typing an account that isn't in the chart and pressing Tab
 * just emptied the Account column. The Account column of Write Checks / Enter Credit Card
 * Charges, Enter Bills, Make Deposits (extra lines) and Make General Journal Entries now opens the
 * Add Account dialog with the typed name; the new account is saved to the Chart of Accounts and
 * put on the line.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { choiceForTypedText, type TypeaheadChoice } from './typeahead';

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

describe('Account Not Found — Set Up', () => {
  const ACCOUNTS: TypeaheadChoice[] = [
    { id: 'rent', label: '6400 – Rent', terms: ['6400', 'Rent'] },
    { id: 'util', label: '6600 – Utilities', terms: ['6600', 'Utilities'] },
  ];

  it('only a name that matches no account counts as new', () => {
    expect(choiceForTypedText(ACCOUNTS, 'Contract Labor', '')).toBeNull(); // → Set Up dialog
    expect(choiceForTypedText(ACCOUNTS, 'rent', '')).toBe('rent'); // existing name, any case
    expect(choiceForTypedText(ACCOUNTS, '6600', '')).toBe('util'); // account number
  });

  it('AccountSelect opens Add Account with the typed name and puts the new account on the line', () => {
    const src = read('components/AccountSelect.tsx');
    expect(src).toContain('onUnknown={(text) => setNewName(text)}');
    expect(src).toContain("initial={{ name: newName, qbType: newAccountType }}");
    expect(src).toMatch(/onAccountCreated\(a\);\s*onChange\(a\.id\);/);
    // Rendered outside the transaction's <form> and its submit / Enter stop there: Create
    // Account must not also save the check or move the line grid.
    expect(src).toContain('createPortal(');
    expect(src).toContain('onSubmit={(e) => e.stopPropagation()}');
  });

  it.each([
    ['app/expenses/page.tsx', 'Line ${idx + 1} account'],
    ['app/bills/page.tsx', 'Line ${idx + 1} account'],
    ['app/journal/page.tsx', 'Line ${idx + 1} account'],
    ['app/deposits/page.tsx', 'Extra line ${idx + 1} account'],
  ])('%s: the line Account column is an AccountSelect that adds the new account to the page', (file, label) => {
    const src = read(file);
    const at = src.indexOf(`aria-label={\`${label}\`}`);
    expect(at).toBeGreaterThan(0);
    const tag = src.lastIndexOf('<', at);
    expect(src.slice(tag, tag + 14)).toBe('<AccountSelect');
    expect(src).toContain('onAccountCreated=');
    expect(src).toMatch(/setAccounts\(\(prev\) => \[\.\.\.prev, a/);
  });
});

describe('Banking: imported lines not in the books yet', () => {
  it('shows "Review & categorize" whenever the account has lines waiting, linking to that account', () => {
    const src = read('app/banking/page.tsx');
    expect(src).toContain('&filter=unreviewed`');
    expect(src).toContain('{pendingReview > 0 && (');
    expect(src).toContain('href={`/bank-review?bankAccountId=${encodeURIComponent(importBankAccountId)}`}');
    // Refreshed after every import (importSummary) and when another account is picked.
    expect(src).toContain('}, [importBankAccountId, importSummary]);');
  });
});

describe('Bank review: account Set Up and proactive rules', () => {
  it('each line picks its account with AccountSelect and reports a saved rule', () => {
    const src = read('app/bank-review/page.tsx');
    expect(src).toContain('<AccountSelect');
    expect(src).toContain("newAccountType={Number(txn.amount) > 0 ? 'income' : 'expense'}");
    expect(src).toContain('toast(learnedRuleMessage(res.learnedRule)');
    // ?bankAccountId= from the Banking page opens that account.
    expect(src).toContain("new URLSearchParams(window.location.search).get('bankAccountId')");
  });
});
