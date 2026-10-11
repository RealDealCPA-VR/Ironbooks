/**
 * Tests for the plain-language UX helpers:
 *  - glossary (lib/glossary.ts): required terms exist, aliases resolve
 *  - command-palette intents (lib/nav-actions.ts matchIntents)
 *  - journal-entry live balance (lib/journalBalance.ts)
 *  - Home workflow diagram (lib/homeWorkflow.ts): every link is a real page; balances panel
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GLOSSARY, GLOSSARY_KEYS, glossaryAnchor, lookupTerm } from './glossary';
import { matchIntents, navIntents } from './nav-actions';
import { computeJournalBalance, journalPayloadAmount, normalizeAmount } from './journalBalance';
import { allWorkflowHrefs, buildAccountBalances, HOME_WORKFLOW } from './homeWorkflow';

const APP_DIR = path.resolve(__dirname, '..', 'app');

/** True when `href` (path part) resolves to an app/<path>/page.tsx (or a dynamic segment). */
function routeExists(href: string): boolean {
  const pathOnly = href.split(/[?#]/)[0];
  if (pathOnly === '') return true; // same-page anchor
  const segs = pathOnly.replace(/^\//, '').split('/').filter(Boolean);
  let dir = APP_DIR;
  for (const seg of segs) {
    const direct = path.join(dir, seg);
    if (fs.existsSync(direct)) {
      dir = direct;
      continue;
    }
    const dyn = fs.readdirSync(dir).find((d) => /^\[.+\]$/.test(d));
    if (!dyn) return false;
    dir = path.join(dir, dyn);
  }
  return fs.existsSync(path.join(dir, 'page.tsx'));
}

describe('glossary', () => {
  it('covers the required accounting terms', () => {
    for (const k of [
      'ar', 'ap', 'undeposited-funds', 'accrual', 'cash-basis', 'accrual-vs-cash', 'class',
      'closing-date', 'reconcile', 'debit-credit', 'retained-earnings', 'opening-balance-equity',
    ]) {
      expect(GLOSSARY_KEYS, k).toContain(k);
    }
  });

  it('every entry has a short plain-language definition', () => {
    for (const k of GLOSSARY_KEYS) {
      const e = GLOSSARY[k];
      expect(e.term.length, k).toBeGreaterThan(2);
      expect(e.short.length, k).toBeGreaterThan(30);
      expect(e.short.length, k).toBeLessThan(320); // tooltip-sized
    }
  });

  it('lookupTerm resolves keys, names and aliases case-insensitively', () => {
    expect(lookupTerm('A/R')?.key).toBe('ar');
    expect(lookupTerm('accounts payable')?.key).toBe('ap');
    expect(lookupTerm('Undeposited Funds')?.key).toBe('undeposited-funds');
    expect(lookupTerm('OBE')?.key).toBe('opening-balance-equity');
    expect(lookupTerm('debit')?.key).toBe('debit-credit');
    expect(lookupTerm('  ')).toBeNull();
    expect(lookupTerm('flux capacitor')).toBeNull();
    expect(glossaryAnchor('ar')).toBe('term-ar');
  });

  it('aliases are unique across entries (no ambiguous lookups)', () => {
    const seen = new Map<string, string>();
    for (const k of GLOSSARY_KEYS) {
      const e: { aliases?: string[] } = GLOSSARY[k];
      for (const a of e.aliases ?? []) {
        const n = a.toLowerCase();
        expect(seen.get(n), `alias "${a}" on ${k} and ${seen.get(n)}`).toBeUndefined();
        seen.set(n, k);
      }
    }
  });
});

describe('command palette intents (matchIntents)', () => {
  const top = (q: string) => matchIntents(q)[0]?.href;

  it('maps everyday phrases to the right screen', () => {
    expect(top('I got paid')).toBe('/payments?new=1');
    expect(top('customer paid me')).toBe('/payments?new=1');
    expect(top('record a sale')).toBe('/sales-receipts?new=1');
    expect(top('pay a bill')).toBe('/pay-bills');
    expect(top('customer owes me')).toBe('/invoices?new=1');
    expect(top('who owes me money')).toBe('/reports/ar-aging');
    expect(top('move money between accounts')).toBe('/transfers');
    expect(top('fix a mistake')).toBe('/help#fix-a-mistake');
    expect(top('I made a mistake!')).toBe('/help#fix-a-mistake');
    expect(top('got a bill from my supplier')).toBe('/bills');
  });

  it('tolerates punctuation, case and extra words', () => {
    expect(top('  I GOT PAID today!! ')).toBe('/payments?new=1');
    expect(top('how do i move money between my accounts?')).toBe('/transfers');
  });

  it('matches partial typing of the last word', () => {
    expect(matchIntents('transf').map((i) => i.href)).toContain('/transfers');
  });

  it('returns nothing for blank or unrelated queries', () => {
    expect(matchIntents('')).toEqual([]);
    expect(matchIntents('the a my')).toEqual([]);
    expect(matchIntents('zebra quantum')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(matchIntents('pay', 2).length).toBeLessThanOrEqual(2);
  });

  it('every intent links to a real page', () => {
    for (const i of navIntents) expect(routeExists(i.href), `${i.label} -> ${i.href}`).toBe(true);
  });
});

describe('computeJournalBalance', () => {
  const line = (accountId: string, debit = '', credit = '') => ({ accountId, debit, credit });

  it('balanced entry can be saved', () => {
    const b = computeJournalBalance([line('a', '100.00'), line('b', '', '100')]);
    expect(b.balanced).toBe(true);
    expect(b.canSave).toBe(true);
    expect(b.difference).toBe('0.00');
    expect(b.blocker).toBeNull();
  });

  it('is decimal-exact (0.1 + 0.2 = 0.3)', () => {
    const b = computeJournalBalance([line('a', '0.10'), line('b', '0.20'), line('c', '', '0.30')]);
    expect(b.totalDebits).toBe('0.30');
    expect(b.balanced).toBe(true);
  });

  it('reports the difference and which side to fix', () => {
    const b = computeJournalBalance([line('a', '150'), line('b', '', '100')]);
    expect(b.canSave).toBe(false);
    expect(b.difference).toBe('50.00');
    expect(b.blocker).toMatch(/Debits are 50\.00 more than credits/);
    const c = computeJournalBalance([line('a', '10'), line('b', '', '12.5')]);
    expect(c.difference).toBe('-2.50');
    expect(c.blocker).toMatch(/Credits are 2\.50 more/);
  });

  it('blocks invalid amounts, missing accounts and one-line entries', () => {
    expect(computeJournalBalance([line('a', '1.2.3'), line('b', '', '1')]).blocker).toMatch(/Line 1/);
    expect(computeJournalBalance([line('a', '-5'), line('b', '', '5')]).canSave).toBe(false);
    expect(computeJournalBalance([line('a', '5'), line('', '', '5')]).blocker).toMatch(/at least two/);
    expect(
      computeJournalBalance([line('a', '5'), line('b', '', '5'), line('', '3')]).blocker,
    ).toMatch(/Line 3 needs both/);
    expect(computeJournalBalance([line('a'), line('b')]).blocker).toMatch(/Line 1 needs both/);
  });

  it('ignores fully blank extra rows and accepts thousands separators', () => {
    const b = computeJournalBalance([line('a', '1,250.00'), line('b', '', '1250'), line('')]);
    expect(b.canSave).toBe(true);
  });

  it('zero-amount entry is not balanced', () => {
    const b = computeJournalBalance([line('a', '0'), line('b', '', '0')]);
    expect(b.balanced).toBe(false);
    expect(b.canSave).toBe(false);
  });

  it('blocks a line with both a debit and a credit, with a plain-language reason', () => {
    const b = computeJournalBalance([line('a', '10', '5'), line('b', '', '5')]);
    expect(b.canSave).toBe(false);
    expect(b.invalidLines).toEqual([1]);
    expect(b.blocker).toMatch(/Line 1 has both a debit and a credit/);
    // A zero on the other side is not "both sides".
    expect(computeJournalBalance([line('a', '5', '0'), line('b', '', '5')]).canSave).toBe(true);
  });

  it('the payload amount is exactly the string the Save gate validated', () => {
    expect(normalizeAmount(' 1,250.00 ')).toBe('1250.00');
    expect(journalPayloadAmount(' 7.25 ')).toBe('7.25');
    expect(journalPayloadAmount('  ')).toBeUndefined();
    expect(journalPayloadAmount(null)).toBeUndefined();
  });
});

describe('Home workflow diagram', () => {
  it('has the five QuickBooks home sections', () => {
    expect(HOME_WORKFLOW.map((s) => s.id)).toEqual(['vendors', 'customers', 'employees', 'company', 'banking']);
  });

  it('flows follow the QuickBooks order', () => {
    const labels = (id: string) => HOME_WORKFLOW.find((s) => s.id === id)!.flows[0].map((s) => s.label);
    expect(labels('vendors')).toEqual(['Purchase Orders', 'Receive Inventory', 'Enter Bills', 'Pay Bills']);
    expect(labels('customers')).toEqual([
      'Estimates', 'Sales Orders', 'Create Invoices', 'Receive Payments', 'Record Deposits',
    ]);
    expect(labels('employees')).toEqual(['Enter Time', 'Pay Employees', 'Pay Liabilities', 'Payroll Forms']);
  });

  it('every link points at a page that exists in app/', () => {
    for (const href of allWorkflowHrefs()) expect(routeExists(href), href).toBe(true);
  });

  it('buildAccountBalances signs banks and cards naturally and orders them', () => {
    const accts = [
      { id: 'cc', code: '2100', name: 'Visa', type: 'liability', subtype: 'credit_card' },
      { id: 'uf', code: '1050', name: 'Undeposited Funds', type: 'asset', subtype: 'checking' },
      { id: 'chk', code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' },
      { id: 'sav', code: '1010', name: 'Savings', type: 'asset', subtype: 'savings', isActive: false },
      { id: 'ar', code: '1200', name: 'A/R', type: 'asset', subtype: 'accounts_receivable' },
    ];
    const rows = buildAccountBalances(accts, [
      { accountId: 'chk', debit: '1000.10', credit: '0' },
      { accountId: 'cc', debit: '0', credit: '250.00' },
      { accountId: 'uf', debit: '75', credit: '0' },
      { accountId: 'ar', debit: '999', credit: '0' },
    ]);
    expect(rows.map((r) => [r.id, r.kind, r.balance])).toEqual([
      ['chk', 'bank', '1000.10'],
      ['uf', 'undeposited', '75.00'],
      ['cc', 'credit_card', '250.00'],
    ]);
  });
});
