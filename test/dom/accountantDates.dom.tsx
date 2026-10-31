// Accountant Center date defaults on fixed clocks (test/dom/clock.ts), by the LOCAL calendar:
// Working Trial Balance opens on January 1 of this year through today, and loads that range;
// Period Copy opens on last calendar year and creates the copy for it.
// test/accountantUi.review5.test.ts runs this file in a zone west and a zone east of UTC, where
// New Year's Eve 11:30 pm or New Year's Day 12:30 / 8 am is another year in UTC.
import * as React from 'react';
import WorkingTrialBalancePage from '@/app/accountant/working-trial-balance/page';
import PeriodCopyPage from '@/app/accountant/period-copy/page';
import { $, button, check, click, domTest, equal, mount, reply, runDomTests, stubFetch, textOf, until, type FetchCall } from './kit';
import { atLocalTime, localInstant, straddlesUtcYear } from './clock';

type Clock = [number, number, number, number, number];
interface Case {
  name: string;
  clock: Clock;
  today: string;
  yearStart: string;
  lastYear: { from: string; to: string };
}

const CASES: Case[] = [
  { name: 'October 30, 2026, noon', clock: [2026, 10, 30, 12, 0], today: '2026-10-30', yearStart: '2026-01-01', lastYear: { from: '2025-01-01', to: '2025-12-31' } },
  // The last half-hour of 2026: still 2026 (in Los Angeles it is already 2027 in UTC).
  { name: 'December 31, 2026, 11:30 pm', clock: [2026, 12, 31, 23, 30], today: '2026-12-31', yearStart: '2026-01-01', lastYear: { from: '2025-01-01', to: '2025-12-31' } },
  // The first half-hour of 2027: a one-day range, and 2026 is the year to copy (in Tokyo it is still 2026 in UTC).
  { name: 'January 1, 2027, 12:30 am', clock: [2027, 1, 1, 0, 30], today: '2027-01-01', yearStart: '2027-01-01', lastYear: { from: '2026-01-01', to: '2026-12-31' } },
  { name: 'January 1, 2027, 8 am', clock: [2027, 1, 1, 8, 0], today: '2027-01-01', yearStart: '2027-01-01', lastYear: { from: '2026-01-01', to: '2026-12-31' } },
];

const value = (id: string) => $<HTMLInputElement>(`#${id}`)?.value;

// Named after the zone the window really runs in: the vitest side expects the zone it asked for
// (process.env.TZ), so a window that ignored TZ would fail rather than test the same zone twice.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
domTest(`the window runs in ${ZONE}, where a UTC year boundary falls inside these clocks`, () => {
  check(
    CASES.some((c) => straddlesUtcYear(localInstant(...c.clock))),
    `in ${ZONE} no clock here is another year in UTC, so a UTC-calendar bug would go unseen`,
  );
});

domTest('Working Trial Balance: opens on January 1 of this year through today, and loads that range', async () => {
  for (const c of CASES) {
    await atLocalTime(c.clock, async () => {
      const calls = stubFetch({
        'GET /api/accounts': [],
        'GET /api/accountant/working-trial-balance': (call: FetchCall) => {
          const q = new URL(call.path, 'http://x').searchParams;
          return { from: q.get('from'), to: q.get('to'), rows: [], totals: { beginning: '0', transactions: '0', adjustments: '0', ending: '0' }, balanced: true };
        },
      });
      await mount(<WorkingTrialBalancePage />);
      await until(() => $('#wtb-from'), 'the period boxes');
      equal(value('wtb-from'), c.yearStart, `${c.name}: Period from`);
      equal(value('wtb-to'), c.today, `${c.name}: to`);
      check(value('wtb-from')! <= value('wtb-to')!, `${c.name}: the range starts on or before today`);
      const load = await until(() => calls.find((x) => x.path.startsWith('/api/accountant/working-trial-balance?')), `${c.name}: the trial balance request`);
      equal(load.path, `/api/accountant/working-trial-balance?from=${c.yearStart}&to=${c.today}`, `${c.name}: the range loaded`);
      await until(() => textOf().includes('In balance'), `${c.name}: the loaded trial balance`);
    });
  }
});

domTest('Period Copy: opens on last calendar year, and creates the copy for it', async () => {
  for (const c of CASES) {
    await atLocalTime(c.clock, async () => {
      // The copy itself is not made here: the request is what is checked.
      const calls = stubFetch({ 'POST /api/period-copy': reply(500, { error: 'not in this test' }) });
      await mount(<PeriodCopyPage />);
      await until(() => $('#pc-from'), 'the First day box');
      equal(value('pc-from'), c.lastYear.from, `${c.name}: First day`);
      equal(value('pc-to'), c.lastYear.to, `${c.name}: Last day`);
      await click(button(/Create Period Copy/), 'Create Period Copy');
      const post = await until(() => calls.find((x) => x.method === 'POST' && x.path === '/api/period-copy'), `${c.name}: the Period Copy request`);
      equal(JSON.stringify(post.body), JSON.stringify(c.lastYear), `${c.name}: the period copied`);
    });
  }
});

void runDomTests();
