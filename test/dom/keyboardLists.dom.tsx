// QuickBooks keys in lists, registers, reports and pickers, pressed as a keyboard would
// (test/keyboardDom.test.ts): Up / Down / Home / End, type a name, Enter = QuickZoom, Left / Right
// a column, Ctrl+PgUp / Ctrl+PgDn a register month, Ctrl+G / Ctrl+O / Ctrl+V / Ctrl+U / Ctrl+Q /
// Ctrl+F6 on the highlighted row, first-letter type-ahead in pickers and menus, and the window keys.
import * as React from 'react';
import { domTest, mount, press, typeText, equal, check, until, runDomTests, $, settle, sleep, focusedLabel } from './kit';
import { Table, Td, Th, Tr, Modal, Button } from '@/components/ui';
import KeyboardCommands from '@/components/KeyboardCommands';
import KeyboardBase from '@/components/KeyboardBase';
import WindowList from '@/components/WindowList';
import { Typeahead } from '@/components/Typeahead';
import { usePickerKeys } from '@/lib/menuKeys';
import { useListKeys } from '@/lib/shortcuts';
import { PASTE_TRANSACTION_EVENT } from '@/lib/keyboardTargets';

const pushes = () => window.__nav.pushes;
const resetNav = () => {
  window.__nav.pushes.length = 0;
  window.__nav.backs = 0;
  window.__nav.forwards = 0;
};
const active = () => $('[data-list-active]')?.querySelector('td')?.textContent?.trim() ?? '(none)';

function Customers({ onOpen }: { onOpen: (name: string) => void }) {
  const names = ['Anderson Plumbing', 'Baker Supply', 'Carter Homes', 'Cooper Electric'];
  return (
    <main>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
          </tr>
        </thead>
        <tbody>
          {names.map((n) => (
            <Tr key={n} data-row-open="" onClick={() => onOpen(n)} data-quick-report={`/qr/${n[0]}`} data-use-href={`/use/${n[0]}`}>
              <Td>{n}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </main>
  );
}

domTest('a list: arrows, Home / End, type a name, Enter opens the row', async () => {
  const opened: string[] = [];
  await mount(<Customers onOpen={(n) => opened.push(n)} />);
  $<HTMLElement>('[data-list]')!.focus();
  await press('ArrowDown');
  equal(active(), 'Anderson Plumbing', 'Down starts at the top');
  await press('ArrowDown');
  equal(active(), 'Baker Supply', 'Down');
  await press('End');
  equal(active(), 'Cooper Electric', 'End');
  await press('Home');
  equal(active(), 'Anderson Plumbing', 'Home');
  await press('c');
  equal(active(), 'Carter Homes', 'c jumps to the first C');
  await press('c');
  equal(active(), 'Cooper Electric', 'c again walks the C’s');
  await press('Enter');
  equal(opened.join(','), 'Cooper Electric', 'Enter opens the highlighted row');
});

domTest('with nothing focused, the list keys go to the page’s first list (a center opened with Ctrl+J)', async () => {
  await mount(
    <>
      <KeyboardCommands />
      <Customers onOpen={() => {}} />
    </>,
  );
  (document.activeElement as HTMLElement | null)?.blur?.();
  await press('b');
  equal(active(), 'Baker Supply', 'b from the page');
  check(document.activeElement?.hasAttribute('data-list'), 'the list took the focus');
});

domTest('Ctrl+Q, Ctrl+U and Ctrl+F6 act on the highlighted row', async () => {
  resetNav();
  await mount(
    <>
      <KeyboardCommands />
      <WindowList />
      <Customers onOpen={() => {}} />
    </>,
  );
  $<HTMLElement>('[data-list]')!.focus();
  await press('c');
  await press('q', { ctrl: true });
  await until(() => pushes().includes('/qr/C'), 'Ctrl+Q QuickReport');
  await press('u', { ctrl: true });
  await until(() => pushes().includes('/use/C'), 'Ctrl+U uses the row');
  resetNav();
  await press('F6', { ctrl: true });
  await until(() => pushes().includes('/qr/C'), 'Ctrl+F6 on a highlighted name: its QuickReport (Intuit)');
});

function WideReport() {
  const cols = ['Date', 'Num', 'Name', 'Memo', 'Account', 'Class', 'Debit', 'Credit'];
  const list = useListKeys<HTMLDivElement>();
  return (
    <div {...list} style={{ width: 400, overflowX: 'auto' }} aria-label="Report">
      <table style={{ width: cols.length * 200, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={{ width: 200, padding: 0 }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {cols.map((c) => (
              <td key={c} style={{ padding: 0 }}>
                {c}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

domTest('Left / Right scroll a wide report a column at a time', async () => {
  await mount(<WideReport />);
  const box = $<HTMLElement>('[aria-label="Report"]')!;
  box.focus();
  await press('ArrowRight');
  equal(box.scrollLeft, 200, 'Right: one column');
  await press('ArrowRight');
  equal(box.scrollLeft, 400, 'Right again');
  await press('ArrowLeft');
  equal(box.scrollLeft, 200, 'Left: back a column');
  await press('Home');
  await press('ArrowLeft');
  await press('ArrowLeft');
  equal(box.scrollLeft, 0, 'stops at the first column');
});

function Register({ onPaste }: { onPaste: (detail: unknown) => void }) {
  React.useEffect(() => {
    const h = (e: Event) => onPaste((e as CustomEvent).detail);
    window.addEventListener(PASTE_TRANSACTION_EVENT, h);
    return () => window.removeEventListener(PASTE_TRANSACTION_EVENT, h);
  }, [onPaste]);
  const rows = [
    { d: '2026-01-05', p: 'Jan rent', other: 'acct-rent' },
    { d: '2026-01-20', p: 'Jan phone', other: 'acct-phone' },
    { d: '2026-02-03', p: 'Feb rent', other: 'acct-rent' },
    { d: '2026-02-17', p: 'Feb split', other: null },
    { d: '2026-04-09', p: 'Apr rent', other: 'acct-rent' },
  ];
  return (
    <main>
      <Table>
        <tbody>
          {rows.map((r) => (
            <Tr
              key={r.p}
              data-row-date={r.d}
              data-list-label={r.p}
              data-journal-entry={`je-${r.p}`}
              data-transfer-href={r.other ? `/registers/${r.other}?entry=je-${r.p.replace(/ /g, '-')}` : undefined}
              data-split={r.other ? undefined : ''}
              data-copy-transaction={
                r.other ? JSON.stringify({ payee: r.p, accountId: r.other, accountLabel: 'Rent', memo: '', side: 'decrease', amount: '1200.00' }) : undefined
              }
            >
              <Td>{r.p}</Td>
              <Td>{r.d}</Td>
            </Tr>
          ))}
          <tr data-register-entry="" data-blank="">
            <td>
              <input aria-label="Blank line payee" />
            </td>
          </tr>
        </tbody>
      </Table>
    </main>
  );
}

domTest('a register: Ctrl+PgUp / Ctrl+PgDn go a month back / on', async () => {
  await mount(<Register onPaste={() => {}} />);
  $<HTMLElement>('[data-list]')!.focus();
  await press('End');
  equal(active(), 'Apr rent', 'End: the newest');
  await press('PageUp', { ctrl: true });
  equal(active(), 'Feb rent', 'Ctrl+PgUp: the month before (March is empty: February)');
  await press('PageUp', { ctrl: true });
  equal(active(), 'Jan rent', 'Ctrl+PgUp: January');
  await press('PageDown', { ctrl: true });
  equal(active(), 'Feb rent', 'Ctrl+PgDn: February');
  await press('PageDown', { ctrl: true });
  equal(active(), 'Apr rent', 'Ctrl+PgDn: April');
});

domTest('a register: Ctrl+G opens the other account’s register; a split says why it cannot', async () => {
  resetNav();
  await mount(
    <>
      <KeyboardCommands />
      <Register onPaste={() => {}} />
    </>,
  );
  $<HTMLElement>('[data-list]')!.focus();
  await press('j');
  equal(active(), 'Jan rent', 'j');
  await press('g', { ctrl: true });
  await until(() => pushes().includes('/registers/acct-rent?entry=je-Jan-rent'), 'Ctrl+G');
  resetNav();
  await sleep(1100); // a pause starts a new type-ahead word (QuickBooks / Windows lists)
  await press('f');
  await press('f');
  equal(active(), 'Feb split', 'f f');
  await press('g', { ctrl: true });
  await settle(100);
  equal(pushes().length, 0, 'a split goes nowhere');
});

domTest('a register: Ctrl+O copies the highlighted transaction, Ctrl+V on the blank line pastes it', async () => {
  const pasted: unknown[] = [];
  await mount(
    <>
      <KeyboardCommands />
      <Register onPaste={(d) => pasted.push(d)} />
    </>,
  );
  $<HTMLElement>('[data-list]')!.focus();
  await press('a');
  equal(active(), 'Apr rent', 'a');
  await press('o', { ctrl: true });
  $<HTMLInputElement>('[aria-label="Blank line payee"]')!.focus();
  await press('v', { ctrl: true });
  await until(() => pasted.length === 1, 'Ctrl+V pasted the copied transaction');
  equal((pasted[0] as { payee: string }).payee, 'Apr rent', 'the copied payee');
  equal((pasted[0] as { amount: string }).amount, '1200.00', 'the copied amount');
});

function Picker() {
  const [value, setValue] = React.useState('');
  const options = ['Anderson Plumbing', 'Baker Supply', 'Carter Homes'].map((v) => ({ value: v }));
  return (
    <>
      <KeyboardCommands />
      <Typeahead aria-label="Customer" value={value} onChange={setValue} options={options} />
      <input aria-label="Next field" />
      <span data-picked>{value}</span>
    </>
  );
}

domTest('a picker: typing finds the name, Tab takes it (QuickFill); Ctrl+U takes the highlighted entry', async () => {
  await mount(<Picker />);
  $<HTMLInputElement>('[aria-label="Customer"]')!.focus();
  await typeText('ba');
  await press('Tab');
  equal($('[data-picked]')?.textContent, 'Baker Supply', 'QuickFill: "ba" then Tab');
  equal(focusedLabel(), 'Next field', 'and the cursor moves on');
  $<HTMLInputElement>('[aria-label="Customer"]')!.focus();
  await press('a', { ctrl: true });
  await typeText('c');
  await until(() => $('[aria-label="Customer"]')?.getAttribute('aria-expanded') === 'true', 'the list opens');
  await press('u', { ctrl: true });
  await until(() => $('[data-picked]')?.textContent === 'Carter Homes', 'Ctrl+U takes the highlighted entry');
});

function Menu() {
  const picker = usePickerKeys<HTMLDivElement>();
  const items = ['Write Checks', 'Make Deposits', 'Transfer Funds', 'Enter Credit Card Charges'];
  return (
    <div role="menu" onKeyDown={picker.onKeyDown}>
      {items.map((t) => (
        <button key={t} role="menuitem" type="button">
          {t}
        </button>
      ))}
    </div>
  );
}

domTest('a menu: a letter jumps to the item starting with it; arrows wrap', async () => {
  await mount(<Menu />);
  $<HTMLElement>('[role="menuitem"]')!.focus();
  await press('t');
  equal(focusedLabel(), 'Transfer Funds', 't');
  await press('r');
  equal(focusedLabel(), 'Transfer Funds', '"tr" typed quickly spells the start of the same name');
  await sleep(1100);
  await press('e');
  equal(focusedLabel(), 'Enter Credit Card Charges', 'after a pause, e starts a new word');
  await press('ArrowDown');
  equal(focusedLabel(), 'Write Checks', 'Down wraps to the top');
});

function WithDialog() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <span data-open>{open ? 'open' : 'closed'}</span>
      <Modal open={open} onClose={() => setOpen(false)} title="Edit Customer">
        <Button>OK</Button>
      </Modal>
    </>
  );
}

domTest('the window keys: Ctrl+F4 closes the open form; Ctrl+Tab / Ctrl+Shift+Tab move between open windows', async () => {
  resetNav();
  window.sessionStorage.setItem(
    'ironbooks.openWindows',
    JSON.stringify([
      { path: '/customers', href: '/customers', label: 'Customer Center' },
      { path: '/invoices', href: '/invoices', label: 'Create Invoices' },
    ]),
  );
  await mount(
    <>
      <KeyboardBase />
      <WindowList />
      <WithDialog />
    </>,
  );
  await settle(120);
  await press('F4', { ctrl: true });
  await until(() => $('[data-open]')?.textContent === 'closed', 'Ctrl+F4 closes the dialog');
  equal(pushes().length, 0, 'and stays on the page');
  (document.activeElement as HTMLElement | null)?.blur?.();
  await press('Tab', { ctrl: true });
  await until(() => pushes().length === 1, 'Ctrl+Tab');
  equal(pushes()[0], '/customers', 'the first open window');
  await press('Tab', { ctrl: true, shift: true });
  await until(() => pushes().length === 2, 'Ctrl+Shift+Tab');
  window.sessionStorage.removeItem('ironbooks.openWindows');
});

void runDomTests();
