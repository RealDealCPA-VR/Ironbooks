// The Chart of Accounts page (app/accounts/page.tsx), pressed as a keyboard would
// (test/keyboardDom.test.ts): it is ONE list, as in QuickBooks, though it is drawn in a section per
// account type. Arrows and type-ahead run across the sections, and with account numbers on,
// type-ahead matches the number and the name.
import * as React from 'react';
import AccountsPage from '@/app/accounts/page';
import { DEFAULT_COMPANY_PREFERENCES, DEFAULT_MY_PREFERENCES } from '@/lib/preferences';
import { $, $$, domTest, equal, mount, press, runDomTests, sleep, stubFetch, typeText, until } from './kit';

const acct = (id: string, code: string, name: string, type: string, subtype: string, qbType: string) => ({
  id,
  code,
  name,
  type,
  subtype,
  qbType,
  isActive: true,
  balance: '0.00',
  children: [],
});

const TREE = [
  acct('a-chk', '1000', 'Checking', 'asset', 'checking', 'bank'),
  acct('a-sav', '1010', 'Savings', 'asset', 'savings', 'bank'),
  acct('a-ar', '1200', 'Accounts Receivable', 'asset', 'accounts_receivable', 'accounts_receivable'),
  acct('a-ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable', 'accounts_payable'),
  acct('a-inc', '4000', 'Sales Income', 'income', 'sales', 'income'),
];

const activeName = () => $('[data-list-active]')?.querySelectorAll('td')[1]?.textContent?.trim() ?? '(none)';

domTest('Chart of Accounts: one list across the account types; type-ahead on the name or the number', async () => {
  stubFetch({
    'GET /api/preferences': {
      company: { ...DEFAULT_COMPANY_PREFERENCES, accountNumbersEnabled: true },
      my: DEFAULT_MY_PREFERENCES,
    },
    'GET /api/accounts': TREE,
  });
  await mount(<AccountsPage />);
  await until(() => ($$('[data-register]').length === TREE.length ? true : null), 'the accounts listed');
  await until(() => ($('[data-register] td')?.textContent?.trim() === '1000' ? true : null), 'account numbers shown');

  equal($$('[data-list]').length, 1, 'the chart is one list, not one per account type');
  $<HTMLElement>('[data-list]')!.focus();

  await typeText('Accounts Payable');
  equal(activeName(), 'Accounts Payable', 'typing a name in another account type finds it');
  equal($('[data-list-active]')?.getAttribute('data-register'), '/registers/a-ap', 'its register is the Ctrl+R target');

  await press('ArrowDown');
  equal(activeName(), 'Sales Income', 'Down moves on into the next account type');

  await sleep(1100); // the type-ahead word starts over
  await typeText('1200');
  equal(activeName(), 'Accounts Receivable', 'typing an account number finds it');
});

void runDomTests();
