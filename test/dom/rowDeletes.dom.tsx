// One-click deletes: a scheduled report's Delete and a state's payroll-rate Remove ask first. No
// DELETE goes out until the question is confirmed, then exactly one; Cancel sends none.
import * as React from 'react';
import ScheduledReportsPage from '@/app/reports/schedules/page';
import PayrollSetupPage from '@/app/employees/setup/page';
import { $, button, check, click, domTest, equal, mount, reply, runDomTests, settle, stubFetch, textOf, until, type FetchCall } from './kit';

const deletes = (calls: FetchCall[]) => calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
const dialog = () => $('[role="dialog"]');

domTest('Scheduled Reports: Delete asks first; Cancel deletes nothing; confirming deletes once', async () => {
  let gone = false;
  const calls = stubFetch({
    'GET /api/report-schedules': () => ({
      schedules: gone
        ? []
        : [
            {
              id: 's1',
              name: 'Month-end pack',
              memorizedReportId: 'r1',
              groupId: null,
              frequency: 'monthly',
              nextRunAt: '2026-11-01T09:00:00.000Z',
              format: 'csv',
              folder: null,
              isActive: true,
              lastRunAt: null,
              lastStatus: null,
              lastMessage: null,
            },
          ],
      exportFolder: 'C:\\Reports',
    }),
    'GET /api/memorized-reports?withGroups=1': { reports: [{ id: 'r1', name: 'Profit & Loss' }], groups: [] },
    'DELETE /api/report-schedules/s1': () => {
      gone = true;
      return reply(204);
    },
  });
  await mount(<ScheduledReportsPage />);
  const del = await until(() => button('Delete Month-end pack'), 'the schedule row’s Delete button');

  await click(del, 'Delete');
  const ask = await until(dialog, 'a confirmation after Delete');
  check(textOf(ask).includes('Delete this schedule?'), `the confirmation asks about the schedule: ${textOf(ask)}`);
  check(textOf(ask).includes('Month-end pack'), 'the confirmation names the schedule');
  equal(deletes(calls).length, 0, 'nothing is deleted while the question is open');

  await click(button('Cancel', ask), 'Cancel');
  await until(() => !dialog(), 'Cancel closes the question');
  await settle(100);
  equal(deletes(calls).length, 0, 'Cancel deletes nothing');
  check(button('Delete Month-end pack'), 'the schedule is still listed');

  await click(button('Delete Month-end pack'), 'Delete (again)');
  const ask2 = await until(dialog, 'the confirmation again');
  await click(button('Delete', ask2), 'the confirmation’s Delete');
  await until(() => deletes(calls).length > 0, 'the confirmed delete to be sent');
  await until(() => !dialog(), 'the question closes after deleting');
  await until(() => textOf().includes('No scheduled reports'), 'the list reloads without the schedule');
  await settle(100);
  equal(JSON.stringify(deletes(calls)), JSON.stringify(['/api/report-schedules/s1']), 'exactly one DELETE, for that schedule');
});

domTest('Payroll Setup > State payroll taxes: Remove asks first; Cancel removes nothing; confirming removes once', async () => {
  let gone = false;
  const calls = stubFetch({
    'GET /api/employees?includeInactive=true': [],
    'GET /api/accounts': [],
    'GET /api/payroll/adjustments': [],
    'GET /api/payroll/state-settings': () =>
      gone
        ? []
        : [{ id: 'st1', state: 'CA', year: 2026, suiRate: '0.034', suiWageBase: '7000', sdiRate: '0.011', sdiWageBase: '0', accountNumber: null }],
    'GET /api/payroll/workers-comp': [],
    'DELETE /api/payroll/state-settings/st1': () => {
      gone = true;
      return reply(204);
    },
  });
  await mount(<PayrollSetupPage />);
  await click(await until(() => button('State payroll taxes'), 'the State payroll taxes tab'), 'State payroll taxes');
  const remove = await until(() => button('Remove'), 'the CA row’s Remove button');
  check(textOf().includes('3.4%'), 'the CA unemployment rate is listed');

  await click(remove, 'Remove');
  const ask = await until(dialog, 'a confirmation after Remove');
  check(textOf(ask).includes('Remove these state rates?'), `the confirmation asks about the rates: ${textOf(ask)}`);
  check(textOf(ask).includes('CA 2026'), 'the confirmation names the state and year');
  equal(deletes(calls).length, 0, 'nothing is removed while the question is open');

  await click(button('Cancel', ask), 'Cancel');
  await until(() => !dialog(), 'Cancel closes the question');
  await settle(100);
  equal(deletes(calls).length, 0, 'Cancel removes nothing');
  check(textOf().includes('3.4%'), 'the rates are still listed');

  await click(button('Remove'), 'Remove (again)');
  const ask2 = await until(dialog, 'the confirmation again');
  await click(button('Remove', ask2), 'the confirmation’s Remove');
  await until(() => deletes(calls).length > 0, 'the confirmed removal to be sent');
  await until(() => !dialog(), 'the question closes after removing');
  await until(() => !textOf().includes('3.4%'), 'the list reloads without the CA rates');
  await settle(100);
  equal(JSON.stringify(deletes(calls)), JSON.stringify(['/api/payroll/state-settings/st1']), 'exactly one DELETE, for those rates');
});

void runDomTests();
