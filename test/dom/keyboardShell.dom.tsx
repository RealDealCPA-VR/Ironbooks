// The app shell's keys, pressed as a keyboard would (test/keyboardDom.test.ts): the leave-this-form
// guard on every way out (keys, menus, the command bar, Back, links, F5 and its held-down repeats,
// the setup interview), the browser's own Ctrl keys never reaching the browser, Esc closing the
// window, Enter moving between fields when that preference is on, the F1 / ? Help window, F2
// Product Information, and Alt+letter / Alt alone on the desktop menu bar.
import * as React from 'react';
import { domTest, mount, press, typeText, equal, check, until, runDomTests, $, $$, button, click, settle, stubFetch, textOf, focusedLabel } from './kit';
import LeaveGuard from '@/components/LeaveGuard';
import PageRefresh from '@/components/PageRefresh';
import KeyboardBase from '@/components/KeyboardBase';
import WindowList from '@/components/WindowList';
import ShortcutsHelp from '@/components/ShortcutsHelp';
import ProductInfo from '@/components/ProductInfo';
import FormShortcuts from '@/components/FormShortcuts';
import PreferenceBehaviors from '@/components/PreferenceBehaviors';
import WindowTitleBar from '@/components/WindowTitleBar';
import { Button, Input, Modal } from '@/components/ui';
import { historyGuarded, navigateGuarded, UNSAVED_WORK_ATTR } from '@/lib/shortcuts';
import { QB_SHORTCUTS, QB_SHORTCUT_GROUPS } from '@/lib/qbShortcuts';

const nav = () => window.__nav;
const resetNav = () => {
  nav().pushes.length = 0;
  nav().backs = 0;
  nav().forwards = 0;
};
const push = (h: string) => nav().pushes.push(h);
const dialogTitled = (re: RegExp) => $$('[role="dialog"]').find((d) => re.test(d.querySelector('h2')?.textContent ?? '')) ?? null;
const leaveDialog = () => dialogTitled(/Leave this form/);

function TypedPage({ withChrome = false }: { withChrome?: boolean }) {
  return (
    <>
      <LeaveGuard />
      {withChrome && (
        <div data-shell-chrome="" role="dialog" aria-label="Command bar">
          <input aria-label="Command bar search" type="search" />
        </div>
      )}
      <main>
        <input aria-label="Memo" />
        <button type="button">Plain button</button>
        <a href="/vendors">Vendor Center</a>
      </main>
    </>
  );
}

domTest('leaving a form being typed asks first: Cancel stays, Leave goes', async () => {
  resetNav();
  await mount(<TypedPage />);
  $<HTMLInputElement>('[aria-label="Memo"]')!.focus();
  await typeText('Half typed');
  navigateGuarded('/invoices', push);
  const d = await until(leaveDialog, 'Leave this form?');
  await click(button('Cancel', d), 'Cancel');
  await settle();
  equal(nav().pushes.length, 0, 'Cancel stays');
  navigateGuarded('/invoices', push);
  await click(button('Leave', (await until(leaveDialog, 'asked again'))!), 'Leave');
  await until(() => nav().pushes.includes('/invoices'), 'Leave goes');
});

domTest('nothing typed: no question', async () => {
  resetNav();
  await mount(<TypedPage />);
  $<HTMLElement>('button')!.focus();
  navigateGuarded('/invoices', push);
  await until(() => nav().pushes.includes('/invoices'), 'went straight there');
  check(!leaveDialog(), 'no question');
});

domTest('from the command bar (outside the page) it asks about the field the cursor was in', async () => {
  resetNav();
  await mount(<TypedPage withChrome />);
  $<HTMLInputElement>('[aria-label="Memo"]')!.focus();
  await typeText('x');
  $<HTMLInputElement>('[aria-label="Command bar search"]')!.focus();
  await settle();
  navigateGuarded('/invoices', push);
  await until(leaveDialog, 'the command bar path asks like Ctrl+W');
  equal(nav().pushes.length, 0, 'not gone yet');
});

domTest('from the title-bar menus (a mouse click there) it asks about the field the cursor was in', async () => {
  resetNav();
  await mount(
    <>
      <div data-window-titlebar="">
        <button type="button">Company</button>
      </div>
      <TypedPage />
    </>,
  );
  $<HTMLInputElement>('[aria-label="Memo"]')!.focus();
  await typeText('x');
  $<HTMLElement>('[data-window-titlebar] button')!.focus();
  await settle();
  navigateGuarded('/dashboard', push);
  await until(leaveDialog, 'the mouse menu path asks like Alt+C');
});

domTest('Window > Back (Alt+Left) and a page link ask first too', async () => {
  resetNav();
  await mount(
    <>
      <KeyboardBase />
      <TypedPage />
    </>,
  );
  $<HTMLInputElement>('[aria-label="Memo"]')!.focus();
  await typeText('x');
  await press('ArrowLeft', { alt: true });
  let d = await until(leaveDialog, 'Alt+Left asks');
  await click(button('Leave', d), 'Leave');
  await until(() => nav().backs === 1, 'went back after Leave');
  $<HTMLInputElement>('[aria-label="Memo"]')!.focus();
  await typeText('y');
  historyGuarded('forward');
  d = await until(leaveDialog, 'Forward asks');
  await click(button('Cancel', d), 'Cancel');
  equal(nav().forwards, 0, 'Cancel stays');
  $<HTMLInputElement>('[aria-label="Memo"]')!.focus();
  $<HTMLAnchorElement>('a')!.click();
  await until(leaveDialog, 'a link asks');
  equal(nav().pushes.length, 0, 'the link did not leave');
});

domTest('the setup interview (data-unsaved-work) asks even with nothing focused', async () => {
  resetNav();
  await mount(
    <>
      <LeaveGuard />
      <main {...{ [UNSAVED_WORK_ATTR]: '' }}>
        <p>Step 3 of 9</p>
      </main>
    </>,
  );
  (document.activeElement as HTMLElement | null)?.blur?.();
  navigateGuarded('/dashboard', push);
  await until(leaveDialog, 'asks');
});

let mounts = 0;
function Counted() {
  React.useState(() => ++mounts);
  return <input aria-label="Memo" />;
}

domTest('F5 refreshes the window in place; with typed work it asks; held-down repeats never reach the browser', async () => {
  mounts = 0;
  await mount(
    <>
      <LeaveGuard />
      <main>
        <PageRefresh>
          <Counted />
        </PageRefresh>
      </main>
    </>,
  );
  equal(mounts, 1, 'mounted once');
  (document.activeElement as HTMLElement | null)?.blur?.();
  await press('F5');
  await until(() => mounts === 2, 'F5 started the page over');
  $<HTMLInputElement>('[aria-label="Memo"]')!.focus();
  await typeText('typed');
  await press('F5');
  await until(() => dialogTitled(/Refresh this window/), 'F5 over typed work asks');
  equal(mounts, 2, 'not refreshed yet');
  const held = new KeyboardEvent('keydown', { key: 'F5', code: 'F5', repeat: true, bubbles: true, cancelable: true });
  window.dispatchEvent(held);
  check(held.defaultPrevented, 'a held-down repeat is taken too');
  equal($$('[role="dialog"]').filter((d) => /Refresh this window/.test(d.textContent ?? '')).length, 1, 'one question');
  await click(button('Refresh', dialogTitled(/Refresh this window/)!), 'Refresh');
  await until(() => mounts === 3, 'Refresh starts the page over');
});

domTest("the browser's own Ctrl keys never open its dialogs (print, find, new window, reload, open, save, view source, …)", async () => {
  const prevented: string[] = [];
  const spy = (e: KeyboardEvent) => {
    const orig = e.preventDefault.bind(e);
    e.preventDefault = () => {
      prevented.push(e.key.toLowerCase());
      orig();
    };
  };
  window.addEventListener('keydown', spy, true);
  try {
    await mount(
      <main>
        <KeyboardBase />
        <p>Nothing here uses these keys</p>
      </main>,
    );
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const k of ['p', 'f', 'n', 'r', 'o', 's', 'u', 'h', 'j', 'd', 'l', 'e', 'k', 'g']) await press(k, { ctrl: true });
    equal(prevented.join(''), 'pfnrosuhjdlekg', 'each Ctrl key kept from the browser');
  } finally {
    window.removeEventListener('keydown', spy, true);
  }
});

domTest('Esc with nothing open or selected closes the window (back to the one before it)', async () => {
  resetNav();
  window.sessionStorage.setItem('ironbooks.openWindows', JSON.stringify([{ path: '/customers', href: '/customers', label: 'Customer Center' }]));
  await mount(
    <main>
      <WindowList />
      <p>A page</p>
    </main>,
  );
  await settle(120);
  (document.activeElement as HTMLElement | null)?.blur?.();
  await press('Escape');
  await until(() => nav().pushes.includes('/customers'), 'Esc closed this window and showed the one before it');
  window.sessionStorage.removeItem('ironbooks.openWindows');
});

function TwoFieldForm({ onSave }: { onSave: () => void }) {
  return (
    <Modal open onClose={() => {}} title="New Customer" footer={<Button onClick={onSave}>Save &amp; Close</Button>}>
      <Input aria-label="Name" />
      <Input aria-label="Phone" />
    </Modal>
  );
}

domTest('"Pressing Enter moves between fields" on: Enter goes to the next field instead of recording', async () => {
  stubFetch({ 'GET /api/preferences': { company: {}, my: { enterMovesBetweenFields: true } } });
  let saved = 0;
  await mount(
    <>
      <PreferenceBehaviors />
      <FormShortcuts />
      <TwoFieldForm onSave={() => saved++} />
    </>,
  );
  await settle(200);
  $<HTMLInputElement>('[aria-label="Name"]')!.focus();
  await typeText('Acme');
  await press('Enter');
  equal(focusedLabel(), 'Phone', 'Enter moved on');
  equal(saved, 0, 'nothing recorded');
  await press('Enter', { ctrl: true });
  await until(() => saved === 1, 'Ctrl+Enter records');
});

domTest('? and F1 open the Help window; it lists exactly the keys that work, in Intuit’s groups', async () => {
  await mount(
    <main>
      <ShortcutsHelp />
      <p>Page</p>
    </main>,
  );
  (document.activeElement as HTMLElement | null)?.blur?.();
  await press('?');
  await until(() => $('[data-help-shortcuts]'), 'the shortcuts list');
  const done = QB_SHORTCUTS.filter((s) => s.status === 'done' && !s.desktopOnly);
  equal($$('[data-shortcut-row]').length, done.length, 'one row per key that works here');
  const groups = $$('[data-shortcut-group]').map((g) => g.getAttribute('data-shortcut-group'));
  equal(groups.join(','), QB_SHORTCUT_GROUPS.map((g) => g.id).filter((id) => done.some((s) => s.group === id)).join(','), "Intuit's groups, in order");
  equal($$('[data-shortcut-na]').length, QB_SHORTCUTS.filter((s) => s.status === 'na').length, 'the ones that work differently, with why');
  await typeText('register');
  check($$('[data-shortcut-row]').length < done.length && $$('[data-shortcut-row]').length > 0, 'typing filters the list');
  await press('Escape');
  await until(() => !$('[data-help-shortcuts]'), 'Esc closes it');
  await press('F1');
  await until(() => $('[data-help-shortcuts], [data-help-page]'), 'F1 opens Help');
});

domTest('F2 / Ctrl+1 open Product Information; F3 in it shows the technical details', async () => {
  stubFetch({
    'GET /api/product-info': {
      version: '9.9.9',
      node: 'v22',
      database: 'PostgreSQL (PGlite, embedded)',
      singleFile: true,
      fileName: 'Keys Co.ironbooks',
      location: 'C:\\Books\\Keys Co.ironbooks',
      dataFolder: 'C:\\Data',
      sizeBytes: 5_400_000,
      remote: false,
      counts: { transactions: 12, accounts: 40, customers: 3, vendors: 2, employees: 1, otherNames: 0, names: 6, items: 5, classes: 2 },
    },
  });
  await mount(
    <main>
      <ProductInfo />
    </main>,
  );
  await press('F2');
  await until(() => /Keys Co\.ironbooks/.test(textOf()), 'the company file shown');
  check(/5\.1 MB/.test(textOf()), 'its size');
  await press('F3');
  await until(() => $('[data-product-tech]'), 'F3: technical details');
  await press('Escape');
  await until(() => !$('[data-product-info]'), 'Esc closes');
  await press('1', { ctrl: true });
  await until(() => $('[data-product-info]'), 'Ctrl+1 opens it too');
});

domTest('desktop menu bar: Alt+letter opens that menu (QuickBooks letters); Alt alone takes the bar; a form keeps its letters', async () => {
  const opened: number[] = [];
  const menus = ['File', 'Edit', 'View', 'Lists', 'Favorites', 'Company', 'Customers', 'Vendors', 'Employees', 'Banking', 'Reports', 'Window', 'Help'];
  (window as unknown as { bookkeeper?: unknown }).bookkeeper = {
    isDesktop: true,
    chrome: {
      frameless: true,
      platform: 'win32',
      menus: async () => menus,
      popupMenu: async (i: number) => {
        opened.push(i);
        return true;
      },
    },
  };
  stubFetch({});
  try {
    let savedClose = 0;
    await mount(
      <>
        <WindowTitleBar />
        <FormShortcuts />
        <main>
          <p>Page</p>
        </main>
      </>,
    );
    await until(() => $$('[aria-haspopup="menu"]').length === menus.length, 'the menu bar');
    (document.activeElement as HTMLElement | null)?.blur?.();
    const want: [string, string][] = [
      ['f', 'File'],
      ['e', 'Edit'],
      ['v', 'View'],
      ['l', 'Lists'],
      ['a', 'Favorites'],
      ['c', 'Company'],
      ['u', 'Customers'],
      ['o', 'Vendors'],
      ['y', 'Employees'],
      ['b', 'Banking'],
      ['r', 'Reports'],
      ['w', 'Window'],
      ['h', 'Help'],
    ];
    for (const [k, menu] of want) {
      opened.length = 0;
      await press(k, { alt: true });
      await until(() => opened.length === 1, `Alt+${k.toUpperCase()}`);
      equal(menus[opened[0]], menu, `Alt+${k.toUpperCase()} opens ${menu}`);
    }
    // Alt alone: the bar takes the keyboard; a letter then opens its menu.
    opened.length = 0;
    await press('Alt');
    await until(() => document.activeElement?.closest('[data-window-titlebar], nav[aria-label="Application menu"]'), 'Alt alone puts the keyboard on the menu bar');
    await press('o');
    await until(() => opened.length === 1, 'then O');
    equal(menus[opened[0]], 'Vendors', 'O opens Vendors');
    // In a form, Alt+A is Save & Close, not Favorites.
    await mount(
      <>
        <WindowTitleBar />
        <FormShortcuts />
        <Modal open onClose={() => {}} title="Enter Bills" footer={<Button onClick={() => savedClose++}>Save &amp; Close</Button>}>
          <Input aria-label="Vendor" />
        </Modal>
      </>,
    );
    await until(() => $$('[aria-haspopup="menu"]').length === menus.length, 'the menu bar again');
    $<HTMLInputElement>('[aria-label="Vendor"]')!.focus();
    opened.length = 0;
    await press('a', { alt: true });
    await until(() => savedClose === 1, 'Alt+A pressed Save & Close');
    equal(opened.length, 0, 'and opened no menu');
  } finally {
    delete (window as unknown as { bookkeeper?: unknown }).bookkeeper;
  }
});

void runDomTests();
