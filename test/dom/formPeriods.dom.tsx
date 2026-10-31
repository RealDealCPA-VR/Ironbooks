// The tax-form pages open on the last finished quarter / calendar year of the LOCAL calendar,
// on a fixed clock (test/dom/clock.ts). lib/formPeriods.review5.test.ts runs this file in time
// zones where New Year's Eve 11:30 pm or New Year's Day 12:30 am is another year in UTC.
import * as React from 'react';
import PayrollFormsPage from '@/app/payroll-forms/page';
import PayrollReportsPage from '@/app/payroll-forms/reports/page';
import Report1099Page from '@/app/reports/1099/page';
import Form1099EfilePage from '@/app/reports/1099-efile/page';
import { $, button, check, click, domTest, equal, focus, mount, reply, runDomTests, stubFetch, textOf, typeText, until } from './kit';
import { atLocalTime, localInstant, straddlesUtcYear } from './clock';

type Clock = [number, number, number, number, number];
interface Case {
  name: string;
  clock: Clock;
  quarter: { year: string; quarter: string };
  year: string;
}

const CASES: Case[] = [
  // In October the 941 for Q3 is due, not Q1.
  { name: 'October 27, 2026', clock: [2026, 10, 27, 12, 0], quarter: { year: '2026', quarter: '3' }, year: '2025' },
  // The first hour of a quarter: the one just finished.
  { name: 'April 1, 2026, 12:30 am', clock: [2026, 4, 1, 0, 30], quarter: { year: '2026', quarter: '1' }, year: '2025' },
  // The last half-hour of the year: Q4 is not finished, nor is 2026.
  { name: 'December 31, 2026, 11:30 pm', clock: [2026, 12, 31, 23, 30], quarter: { year: '2026', quarter: '3' }, year: '2025' },
  // The first half-hour of the new year: last year's Q4, last year's 1099s / W-2s.
  { name: 'January 1, 2027, 12:30 am', clock: [2027, 1, 1, 0, 30], quarter: { year: '2026', quarter: '4' }, year: '2026' },
];

const value = (id: string) => $<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value;

function choose(select: HTMLSelectElement | null, v: string) {
  check(select, 'the select to choose from');
  select.value = v;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

// Named after the zone the window really runs in: the vitest side expects the zone it asked for
// (process.env.TZ), so a window that ignored TZ would fail rather than test the same zone twice.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
domTest(`the window runs in ${ZONE}, where a UTC year boundary falls inside these clocks`, () => {
  const tz = ZONE;
  check(
    straddlesUtcYear(localInstant(2026, 12, 31, 23, 30)) || straddlesUtcYear(localInstant(2027, 1, 1, 0, 30)),
    `in ${tz} neither New Year clock is another year in UTC, so a UTC-calendar bug would go unseen`,
  );
});

domTest('Process Payroll Forms: 941 on the last finished quarter; W-2, 940 and W-3 on the last finished year', async () => {
  for (const c of CASES) {
    await atLocalTime(c.clock, async () => {
      stubFetch({ 'GET /api/employees?includeInactive=true': [{ id: 'e1', firstName: 'Ann', lastName: 'Lee', isActive: true }] });
      await mount(<PayrollFormsPage />);
      await until(() => $('#q941Quarter'), 'the 941 quarter');
      equal(value('q941Quarter'), c.quarter.quarter, `${c.name}: 941 quarter`);
      equal(value('q941Year'), c.quarter.year, `${c.name}: 941 year`);
      equal(value('w2Year'), c.year, `${c.name}: W-2 year`);
      equal(value('f940Year'), c.year, `${c.name}: 940 year`);
      equal(value('w3Year'), c.year, `${c.name}: W-3 year`);
    });
  }
});

domTest('Payroll reports > State wage worksheet: the last finished quarter, and that is what it runs', async () => {
  for (const c of CASES) {
    await atLocalTime(c.clock, async () => {
      const calls = stubFetch({
        'GET /api/payroll/reports': { employees: [], rows: [], gross: {}, net: {}, totalGross: '0', totalNet: '0' },
        'GET /api/payroll/state-wage-worksheet': reply(500, { error: 'not in this test' }),
      });
      await mount(<PayrollReportsPage />);
      // The Employee Earnings Summary loads first; switching from it once crashed the page (the
      // worksheet view drew the summary's answer), so wait for it before switching.
      await until(() => textOf().includes('No payroll in this period.'), 'the Employee Earnings Summary');
      choose(await until(() => $<HTMLSelectElement>('#rep'), 'the report picker'), 'state-wage');
      await until(() => $('#q'), 'the quarter picker');
      equal(value('q'), c.quarter.quarter, `${c.name}: quarter`);
      equal(value('y'), c.quarter.year, `${c.name}: year`);
      await focus($('#st'), 'the state box');
      await typeText('CA');
      await click(button('Run report'), 'Run report');
      const run = await until(() => calls.find((x) => x.path.startsWith('/api/payroll/state-wage-worksheet')), `${c.name}: the worksheet request`);
      equal(run.path, `/api/payroll/state-wage-worksheet?state=CA&year=${c.quarter.year}&quarter=${c.quarter.quarter}`, `${c.name}: the worksheet asked for`);
    });
  }
});

for (const [title, Page, query] of [
  ['1099 Worksheets', Report1099Page, 'worksheet=1'],
  ['1099 e-file', Form1099EfilePage, 'nec=1'],
] as const) {
  domTest(`${title}: opens on, and loads, the last finished calendar year`, async () => {
    for (const c of CASES) {
      await atLocalTime(c.clock, async () => {
        const calls = stubFetch({ 'GET /api/reports/1099': reply(500, { error: 'not in this test' }) });
        await mount(<Page />);
        await until(() => $('#year'), 'the year picker');
        equal(value('year'), c.year, `${c.name}: calendar year shown`);
        const load = await until(() => calls.find((x) => x.path.startsWith('/api/reports/1099?')), `${c.name}: the 1099 request`);
        equal(load.path, `/api/reports/1099?year=${c.year}&${query}`, `${c.name}: the year loaded`);
      });
    }
  });
}

void runDomTests();
