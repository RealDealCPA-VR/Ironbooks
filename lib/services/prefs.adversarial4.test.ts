/**
 * Wave 2 prefs QA re-test round 3 (adversarial4): twice-a-month (semimonthly) schedules after the
 * fix-round-3 anchor change. Probes the stored anchor (recurring_templates.anchor_day) through
 * edits, frequency switches, catch-up, Enter Now, the calendar, and malformed anchors.
 *
 * Expected behaviour (QuickBooks "Twice a month"): a schedule is a fixed pair of days, the first
 * in 1-15 and the second 15 days later (clamped to month end). Whatever the user edits, the date
 * the template is next due must always be one of the pair's days.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { expenses, recurringTemplates } from '@/lib/db/schema';
import { balanceSheet, trialBalance } from './reports';
import { getCalendar } from './calendar';
import {
  advanceDate,
  createTemplate,
  getTemplate,
  projectOccurrences,
  runDue,
  runTemplateNow,
  semimonthlyAnchor,
  updateTemplate,
} from './recurring';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

describe('semimonthly pure date math (no database)', () => {
  it('ignores malformed anchors (0, 16, 2.5, negative, NaN) and derives one from the date', () => {
    for (const bad of [0, 16, 2.5, -3, Number.NaN, 31]) {
      expect(iso(advanceDate(day('2026-03-20'), 'semimonthly', bad))).toBe('2026-04-05');
    }
  });

  it('never mutates the input date', () => {
    const d = day('2026-01-31');
    advanceDate(d, 'semimonthly', 15);
    advanceDate(d, 'monthly');
    expect(iso(d)).toBe('2026-01-31');
  });

  it('every projected date is strictly increasing and exactly 24 per year for every start day', () => {
    for (let start = 1; start <= 31; start++) {
      const s = `2026-01-${String(start).padStart(2, '0')}`;
      const occ = projectOccurrences(day(s), 'semimonthly', day('2026-01-01'), day('2027-12-31'), 1000);
      for (let i = 1; i < occ.length; i++) expect(occ[i].getTime()).toBeGreaterThan(occ[i - 1].getTime());
      const in2027 = occ.filter((d) => d.getUTCFullYear() === 2027);
      expect(in2027.length, `start ${s}`).toBe(24);
      // two per month, every month
      for (let m = 0; m < 12; m++) {
        expect(in2027.filter((d) => d.getUTCMonth() === m).length, `start ${s} month ${m + 1}`).toBe(2);
      }
    }
  });

  it('the 1st/16th pair does not drift across a year boundary', () => {
    const occ = projectOccurrences(day('2026-12-16'), 'semimonthly', day('2026-12-01'), day('2027-01-31')).map(iso);
    expect(occ).toEqual(['2026-12-16', '2027-01-01', '2027-01-16']);
  });

  it('a stored anchor wins over the second-half date it is applied to', () => {
    expect(iso(advanceDate(day('2026-04-30'), 'semimonthly', 14))).toBe('2026-05-14');
    expect(semimonthlyAnchor(day('2026-04-29'))).toBe(14);
  });

  it('a limit of 0 occurrences projects nothing; a null start projects nothing', () => {
    expect(projectOccurrences(day('2026-01-15'), 'semimonthly', day('2026-01-01'), day('2026-12-31'), 0)).toEqual([]);
    expect(projectOccurrences(null as unknown as Date, 'semimonthly', day('2026-01-01'), day('2026-12-31'))).toEqual([]);
  });
});

describe('memorized twice-a-month templates keep their pair (database)', () => {
  let t: TestCompany;
  beforeAll(async () => {
    t = await makeTestCompany('prefs-adv4');
  }, 120_000);
  afterAll(async () => {
    await t?.cleanup();
  });

  async function mk(name: string, frequency: 'semimonthly' | 'weekly', start: string, amount = '3.00') {
    return createTemplate(t.ctx, {
      name,
      docType: 'expense',
      frequency,
      nextRunDate: day(start),
      mode: 'automatic',
      remaining: null,
      daysInAdvance: 0,
      template: {
        payeeName: 'Landlord',
        method: 'cash',
        memo: name,
        paymentAccountId: t.acct['1000'],
        lines: [{ accountId: t.acct['6400'], amount }],
      },
    });
  }

  async function postedDates(memo: string) {
    const rows = await t.db
      .select({ date: expenses.date })
      .from(expenses)
      .where(and(eq(expenses.companyId, t.ctx.companyId), eq(expenses.memo, memo)));
    return rows.map((r) => iso(new Date(r.date as unknown as string))!).sort();
  }

  it('re-saving a template (UI always re-sends its next date) on a February month-end keeps a 14th/29th pair', async () => {
    // The Edit dialog's scheduleBody() always sends nextRunDate. Changing only the group while the
    // template sits on 2026-02-28 (the clamped 29th) must not turn the pair into 15th/30th.
    const tpl = await mk('adv4-resave', 'semimonthly', '2026-01-14');
    for (const asOf of ['2026-01-14', '2026-01-29', '2026-02-14']) await runDue(t.ctx, day(asOf));
    const cur = await getTemplate(t.ctx, tpl.id);
    expect(iso(cur.nextRunDate)).toBe('2026-02-28');
    await updateTemplate(t.ctx, tpl.id, { groupName: 'Rent', nextRunDate: cur.nextRunDate });
    expect((await getTemplate(t.ctx, tpl.id)).anchorDay).toBe(14);
    await runDue(t.ctx, day('2026-02-28'));
    expect(iso((await getTemplate(t.ctx, tpl.id)).nextRunDate)).toBe('2026-03-14');
  }, 120_000);

  it('switching a weekly template to twice a month pairs on its current next date, not its creation date', async () => {
    // Weekly from 2026-01-05 (stored anchor 5) runs to 2026-01-26; the user then switches to twice a
    // month without touching the date. The next date is the 26th, so the pair must be 11th/26th:
    // after the 26th comes 2026-02-11. With the stale anchor 5 it goes 26 -> 5 -> 20, so the 26th
    // is not even one of the pair's days.
    const tpl = await mk('adv4-switch', 'weekly', '2026-01-05');
    for (const asOf of ['2026-01-05', '2026-01-12', '2026-01-19']) await runDue(t.ctx, day(asOf));
    expect(iso((await getTemplate(t.ctx, tpl.id)).nextRunDate)).toBe('2026-01-26');
    await updateTemplate(t.ctx, tpl.id, { frequency: 'semimonthly' });
    await runDue(t.ctx, day('2026-01-26'));
    expect(iso((await getTemplate(t.ctx, tpl.id)).nextRunDate)).toBe('2026-02-11');
  }, 120_000);

  it('several periods overdue: fires once, then lands on the next pair day after today', async () => {
    const tpl = await mk('adv4-catchup', 'semimonthly', '2026-01-13');
    const res = await runDue(t.ctx, day('2026-04-02'));
    expect(res.failed).toEqual([]);
    expect(res.generated.filter((g) => g.templateId === tpl.id)).toHaveLength(1);
    expect(iso((await getTemplate(t.ctx, tpl.id)).nextRunDate)).toBe('2026-04-13');
    // same day again: idempotent
    const again = await runDue(t.ctx, day('2026-04-02'));
    expect(again.generated.filter((g) => g.templateId === tpl.id)).toHaveLength(0);
    expect(await postedDates('adv4-catchup')).toEqual(['2026-01-13']);
  }, 120_000);

  it('Enter Now keeps a 13th/28th pair through February', async () => {
    // Enter Now catches the schedule up past the real clock, so use dates after it.
    const y = new Date().getUTCFullYear() + 1;
    const tpl = await mk('adv4-now', 'semimonthly', `${y}-02-13`);
    await runTemplateNow(t.ctx, tpl.id, day(`${y}-02-13`));
    const feb = `${y}-02-28`; // 13 + 15, leap year or not
    expect(iso((await getTemplate(t.ctx, tpl.id)).nextRunDate)).toBe(feb);
    await runTemplateNow(t.ctx, tpl.id, day(feb));
    expect(iso((await getTemplate(t.ctx, tpl.id)).nextRunDate)).toBe(`${y}-03-13`);
  }, 120_000);

  it('the calendar shows the stored pair (13th/28th) after February, and the pre-migration null anchor derives it', async () => {
    const tpl = await mk('adv4-cal', 'semimonthly', '2026-02-13');
    // move the template onto February's month-end the way a run would (anchor stays 13)
    await t.db.update(recurringTemplates).set({ nextRunDate: day('2026-02-28') }).where(eq(recurringTemplates.id, tpl.id));
    const cal = await getCalendar(t.ctx, { from: '2026-02-01', to: '2026-03-31', today: '2026-02-01' });
    const dates = cal.days.filter((d) => d.events.some((e) => e.id === tpl.id)).map((d) => d.date);
    expect(dates).toEqual(['2026-02-28', '2026-03-13', '2026-03-28']);

    // A template from before migration 0031 has no anchor: derived from its next date.
    await t.db
      .update(recurringTemplates)
      .set({ anchorDay: null, nextRunDate: day('2026-03-20') })
      .where(eq(recurringTemplates.id, tpl.id));
    const cal2 = await getCalendar(t.ctx, { from: '2026-03-01', to: '2026-04-30', today: '2026-03-01' });
    const dates2 = cal2.days.filter((d) => d.events.some((e) => e.id === tpl.id)).map((d) => d.date);
    expect(dates2).toEqual(['2026-03-20', '2026-04-05', '2026-04-20']);
    await t.db.update(recurringTemplates).set({ isActive: false }).where(eq(recurringTemplates.id, tpl.id));
  }, 120_000);

  it('clearing the next date clears the anchor; a garbage anchor in the database is ignored', async () => {
    const tpl = await mk('adv4-clear', 'semimonthly', '2026-05-07');
    expect((await getTemplate(t.ctx, tpl.id)).anchorDay).toBe(7);
    await updateTemplate(t.ctx, tpl.id, { nextRunDate: null });
    const row = await getTemplate(t.ctx, tpl.id);
    expect(row.nextRunDate).toBeNull();
    expect(row.anchorDay).toBeNull();

    await t.db
      .update(recurringTemplates)
      .set({ anchorDay: 99, nextRunDate: day('2026-05-22') })
      .where(eq(recurringTemplates.id, tpl.id));
    const res = await runDue(t.ctx, day('2026-05-22'));
    expect(res.failed).toEqual([]);
    // 99 is invalid -> derived from 22nd -> anchor 7 -> 2026-06-07 (and never an Invalid Date / rollover)
    expect(iso((await getTemplate(t.ctx, tpl.id)).nextRunDate)).toBe('2026-06-07');
  }, 120_000);

  it('books stay balanced after all the twice-a-month entries', async () => {
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
    expect((await balanceSheet(t.ctx)).balanced).toBe(true);
  }, 120_000);
});
