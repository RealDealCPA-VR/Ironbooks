// The Customer / Vendor Center layout (components/lists/CenterDetail.tsx), pressed as a keyboard
// would (test/keyboardDom.test.ts): the first name is chosen when the list loads, Down / type-ahead
// choose another, and the right side shows that name's balance and transactions.
import * as React from 'react';
import { domTest, mount, press, typeText, equal, check, until, runDomTests, $, $$, button, click, settle, stubFetch, fetchLog } from './kit';
import KeyboardBase from '@/components/KeyboardBase';
import { Table, Tr, Td, Th } from '@/components/ui';
import CenterDetail, { CENTER_ROW_ATTR, useCenterSelection } from '@/components/lists/CenterDetail';

const ACME = '11111111-1111-4111-8111-111111111111';
const BAKER = '22222222-2222-4222-8222-222222222222';
const CEDAR = '33333333-3333-4333-8333-333333333333';
const PEOPLE = [
  { id: ACME, displayName: 'Acme Supply', balance: '125.00', isActive: true, phone: '555-0101' },
  { id: BAKER, displayName: 'Baker Farms', balance: '0.00', isActive: true },
  { id: CEDAR, displayName: 'Cedar Hardware', balance: '42.50', isActive: true },
];

function report(id: string) {
  const rows =
    id === BAKER
      ? [{ id: 'b1', depth: 1, kind: 'data', entryId: 'e-b1', cells: { type: 'Invoice', num: '1002', date: '2026-10-02', memo: 'Hay', account: 'Accounts Receivable', amount: '300.00' } }]
      : [{ id: 'a1', depth: 1, kind: 'data', entryId: 'e-a1', cells: { type: 'Invoice', num: '1001', date: '2026-10-01', memo: '', account: 'Accounts Receivable', amount: '125.00' } }];
  return {
    key: 'transaction-list-by-customer',
    title: 'Transaction List by Customer',
    columns: [],
    rows: [{ id: 'h', depth: 0, kind: 'section', cells: { label: 'x' } }, ...rows, { id: 't', depth: 0, kind: 'total', cells: {} }],
  };
}

function Center() {
  const center = useCenterSelection(PEOPLE.map((p) => p.id), true);
  const selected = PEOPLE.find((p) => p.id === center.selectedId) ?? null;
  return (
    <div ref={center.ref}>
      <KeyboardBase />
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th numeric>Balance</Th>
          </tr>
        </thead>
        <tbody>
          {PEOPLE.map((p) => (
            <Tr key={p.id} {...{ [CENTER_ROW_ATTR]: p.id }} data-list-label={p.displayName}>
              <Td>{p.displayName}</Td>
              <Td numeric>{p.balance}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <CenterDetail kind="customer" record={selected} onEdit={() => {}} />
    </div>
  );
}

function stubReports() {
  stubFetch({
    'GET /api/reports/std/transaction-list-by-customer': (call: { path: string }) => {
      const id = new URL(call.path, 'http://x').searchParams.get('customerId') ?? '';
      return report(id);
    },
  });
}

const shownName = () => $('[data-center-name]')?.textContent ?? '';

domTest('the first name is chosen when the list loads, with its transactions', async () => {
  stubReports();
  await mount(<Center />);
  await until(() => (shownName() === 'Acme Supply' ? true : null), 'Acme Supply on the right');
  await until(() => ($('[aria-label="Transactions"] tbody tr') ? true : null), 'transactions shown');
  const cells = $$('[aria-label="Transactions"] tbody tr td').map((td) => td.textContent);
  check(cells.includes('1001'), 'invoice number shown');
  check(cells.includes('10/01/2026'), 'date shown as MM/DD/YYYY');
  equal($$('[aria-label="Transactions"] tbody tr').length, 1, 'headings and totals left out');
  const get = fetchLog().find((c) => c.method === 'GET');
  check(get?.path.includes(`customerId=${ACME}`) && get.path.includes('dates=all'), 'all dates for the one customer');
});

domTest('Down moves to the next name and the right side follows', async () => {
  stubReports();
  await mount(<Center />);
  await until(() => (shownName() === 'Acme Supply' ? true : null), 'Acme first');
  ($('[data-list]') as HTMLElement).focus();
  await settle();
  await press('ArrowDown');
  await until(() => (shownName() === 'Baker Farms' ? true : null), 'Baker Farms on the right');
  await until(() => ($$('[aria-label="Transactions"] tbody td').some((td) => td.textContent === '1002') ? true : null), 'Baker transactions');
});

domTest('typing a name jumps to it', async () => {
  stubReports();
  await mount(<Center />);
  await until(() => (shownName() === 'Acme Supply' ? true : null), 'Acme first');
  ($('[data-list]') as HTMLElement).focus();
  await settle();
  await typeText('ced');
  await until(() => (shownName() === 'Cedar Hardware' ? true : null), 'Cedar Hardware on the right');
});

domTest('the Dates choice reloads the transactions for that period', async () => {
  stubReports();
  await mount(<Center />);
  await until(() => (shownName() === 'Acme Supply' ? true : null), 'Acme first');
  const dates = $<HTMLSelectElement>('[aria-label="Transaction dates"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(dates, 'this_month');
  dates.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => (fetchLog().some((c) => c.path.includes('dates=this_month')) ? true : null), 'This Month asked for');
});

domTest('New Invoice starts an invoice for the chosen customer', async () => {
  stubReports();
  window.__nav.pushes = [];
  await mount(<Center />);
  await until(() => (shownName() === 'Acme Supply' ? true : null), 'Acme first');
  await click(button(/New Invoice/), 'New Invoice');
  await until(() => (window.__nav.pushes.includes('/invoices') ? true : null), 'went to invoices');
  const stashed = window.sessionStorage.getItem('ironbooks.commandBar.prefill') ?? '';
  check(stashed.includes(ACME), 'invoice prefilled with the customer');
});

void runDomTests();
