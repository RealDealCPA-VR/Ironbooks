// Review-5 leftovers owned by the keyboard team, proved on the real pages (test/keyboardDom.test.ts):
//  - Calendar: deleting a to-do asks first (a single click deleted it).
//  - Report Builder opened from the Memorized Report List (?mem=<id>): a failed load says it could
//    not be loaded — not that the saved report was deleted.
//  - Currencies: the Quick Conversion Reference shows the rate (1 JPY = 0.0067 USD), not a rate
//    rounded to cents ($0.01).
import * as React from 'react';
import { $$, button, check, click, domTest, equal, mount, reply, runDomTests, stubFetch, textOf, until } from './kit';
import { Toaster } from '@/components/ui';
import CalendarPage from '@/app/calendar/page';
import ReportBuilderPage from '@/app/reports/builder/page';
import CurrenciesPage from '@/app/currencies/page';

const PREFS = { company: { multiCurrencyEnabled: true }, my: {} };

function calendarRoutes() {
  return {
    'GET /api/preferences': PREFS,
    'GET /api/calendar': { days: [] },
    'GET /api/todos': {
      todos: [{ id: 't1', title: 'Call Acme about the deposit', notes: null, kind: 'todo', priority: 'normal', dueDate: '2026-11-02', dueTime: null, done: false }],
    },
    'DELETE /api/todos/t1': {},
  };
}

const deletes = (calls: { method: string }[]) => calls.filter((c) => c.method === 'DELETE').length;
const confirmDialog = () => $$('[role="dialog"]').find((d) => /Delete/i.test(d.textContent ?? '') && /Call Acme/.test(d.textContent ?? '')) ?? null;

domTest('Calendar: Delete on a to-do asks first; Cancel keeps it, confirming deletes it once', async () => {
  const calls = stubFetch(calendarRoutes());
  await mount(<CalendarPage />);
  const del = await until(() => button('Delete to-do'), 'the to-do and its Delete button', 4000);
  await click(del, 'Delete to-do');
  const dialog = await until(confirmDialog, 'a confirmation naming the to-do');
  equal(deletes(calls), 0, 'nothing deleted before the answer');
  await click(button('Cancel', dialog), 'Cancel');
  await until(() => !confirmDialog(), 'the confirmation closes');
  equal(deletes(calls), 0, 'Cancel deletes nothing');
  await click(button('Delete to-do'), 'Delete to-do again');
  const again = await until(confirmDialog, 'asked again');
  const yes = $$<HTMLButtonElement>('button', again).find((b) => /^Delete/.test(b.textContent?.trim() ?? '') && b.getAttribute('aria-label') !== 'Close');
  await click(yes ?? null, 'the confirming Delete button');
  await until(() => deletes(calls) === 1, 'one DELETE');
  equal(calls.filter((c) => c.method === 'DELETE')[0].path, '/api/todos/t1', 'the right to-do');
});

domTest('Report Builder: a memorized report that fails to load is not called deleted', async () => {
  window.history.replaceState(null, '', '?mem=r1');
  stubFetch({
    'GET /api/preferences': PREFS,
    'GET /api/memorized-reports': reply(500, { error: 'The server is restarting.' }),
  });
  await mount(
    <>
      <ReportBuilderPage />
      <Toaster />
    </>,
  );
  const said = await until(() => (/saved report/i.test(textOf()) ? textOf() : null), 'a message about the saved report', 4000);
  check(!/deleted/i.test(said), `it must not say the report was deleted: ${said}`);
  check(/could not be loaded/i.test(said), `it says the report could not be loaded: ${said}`);
});

domTest('Report Builder: a memorized report that is really gone still says so', async () => {
  window.history.replaceState(null, '', '?mem=gone');
  stubFetch({
    'GET /api/preferences': PREFS,
    'GET /api/memorized-reports': [],
  });
  await mount(
    <>
      <ReportBuilderPage />
      <Toaster />
    </>,
  );
  await until(() => /could not be found/i.test(textOf()), 'the not-found message', 4000);
});

domTest('Currencies: the Quick Conversion Reference shows small rates in full (1 JPY = 0.0067 USD)', async () => {
  stubFetch({
    'GET /api/preferences': PREFS,
    'GET /api/currencies': [
      { id: 'usd', code: 'USD', name: 'US Dollar', rateToBase: '1.00000000', isBase: true, updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'jpy', code: 'JPY', name: 'Japanese Yen', rateToBase: '0.00670000', isBase: false, updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'eur', code: 'EUR', name: 'Euro', rateToBase: '1.08500000', isBase: false, updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
    'GET /api/accounts': [],
    'GET /api/home-currency-adjustments': [],
  });
  await mount(<CurrenciesPage />);
  const card = await until(
    () => $$('h2').find((h) => h.textContent?.includes('Quick Conversion Reference'))?.parentElement ?? null,
    'the Quick Conversion Reference',
    4000,
  );
  const text = textOf(card);
  check(/1 JPY =\s*\$?0\.0067(?!\d)/.test(text), `1 JPY shows its rate: ${text}`);
  check(!/1 JPY =\s*\$0\.01(?!\d)/.test(text), `not rounded to a cent: ${text}`);
  check(/1 EUR =\s*\$?1\.085(?!\d)/.test(text), `1 EUR shows its rate: ${text}`);
});

void runDomTests();
