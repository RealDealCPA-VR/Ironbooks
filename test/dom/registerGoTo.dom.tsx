// Ctrl+G lands on the transaction in the other register (test/keyboardDom.test.ts): the page asks
// the server for the newest rows reaching back to ?entry=, highlights it, and says so when the
// transaction is not there.
import * as React from 'react';
import RegisterPage from '@/app/registers/[accountId]/page';
import { Toaster } from '@/components/ui';
import { check, domTest, mount, runDomTests, stubFetch, textOf, until, $ } from './kit';

const row = (n: number) => ({
  lineId: `l${n}`,
  journalEntryId: `je-${n}`,
  date: `2026-0${n}-05`,
  entryNumber: n,
  reference: null,
  description: `Transfer ${n}`,
  memo: null,
  sourceRef: null,
  debit: '10.00',
  credit: null,
  runningBalance: `${n * 10}.00`,
  otherAccount: { id: 'acct-checking', label: 'Checking' },
});
const register = (rows: ReturnType<typeof row>[]) => ({
  register: {
    account: { id: 'acct-savings', code: '1010', name: 'Savings', type: 'asset', subtype: 'savings' },
    openingBalance: '0.00',
    closingBalance: '60.00',
    totalRows: 6,
    offset: 6 - rows.length,
    rows,
  },
});

domTest('Ctrl+G at an older transaction: the page asks for rows back to it and highlights it', async () => {
  window.__params = { accountId: 'acct-savings' };
  window.history.replaceState(null, '', '?entry=je-2');
  const calls = stubFetch({
    'GET /api/registers/acct-savings': (c) => (/entry=je-2/.test(c.path) ? register([1, 2, 3, 4, 5, 6].map(row)) : register([5, 6].map(row))),
    'GET /api/accounts': [],
  });
  await mount(
    <>
      <Toaster />
      <RegisterPage />
    </>,
  );
  await until(() => $('tr[data-list-active]'), 'a highlighted row');
  const first = calls.find((c) => c.path.startsWith('/api/registers/acct-savings'));
  check(/entry=je-2/.test(first?.path ?? ''), `the page asked with entry= (${first?.path})`);
  await until(() => $('tr[data-list-active]')?.getAttribute('data-journal-entry') === 'je-2', 'the transaction is highlighted');
});

domTest('Ctrl+G at a transaction that is not in the rows: a note, not a silent bottom of the register', async () => {
  window.__params = { accountId: 'acct-savings' };
  window.history.replaceState(null, '', '?entry=je-gone');
  stubFetch({ 'GET /api/registers/acct-savings': register([5, 6].map(row)), 'GET /api/accounts': [] });
  await mount(
    <>
      <Toaster />
      <RegisterPage />
    </>,
  );
  await until(() => /not in the rows shown here/.test(textOf()), 'the note');
});

void runDomTests();
