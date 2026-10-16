/**
 * Regression tests for UI-layer date / money bugs found in review:
 *  - API calendar days ("2026-06-09T00:00:00.000Z") were shown as the day before in US zones
 *    (lib/dates.ts, lib/utils.ts, reports fmtDate and per-page copies) — now lib/format.ts.
 *  - Audit Trail From/To mixed UTC-midnight parsing with local setHours() and searched the
 *    wrong day — now lib/dates.ts localDayStartIso / localDayEndIso.
 *  - Invoice %-discount lines were rounded with float math and saved a cent off — now
 *    lib/invoiceLineMath.ts.
 * Run under a US zone (and a positive-offset zone for the timestamp cases).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { formatDate, formatShortDate, formatDateWith, isCalendarDay, toDisplayDate } from './format';
import {
  firstOfNextMonthISO,
  formatDate as datesFormatDate,
  localDateISO,
  localDayEndIso,
  localDayStartIso,
  todayISO,
} from './dates';
import { todayStr as reportTodayStr } from '../app/reports/_components/shared';
import { formatDate as utilsFormatDate } from './utils';
import { liveLineTotals, typedNumber, type LiveLineInput } from './invoiceLineMath';
import { Money, toAmountString } from './money';
import { fmtDate as reportFmtDate } from '../app/reports/_components/shared';

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const SERVER_DAY = '2026-06-09T00:00:00.000Z'; // a June 9 business date as the API returns it

for (const tz of ['America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']) {
  describe(`calendar-day display in ${tz}`, () => {
    beforeEach(() => {
      process.env.TZ = tz;
    });

    it('lib/format formatDate / formatShortDate / formatDateWith show the named day', () => {
      expect(formatDate(SERVER_DAY)).toBe('Jun 9, 2026');
      expect(formatDate('2026-06-09')).toBe('Jun 9, 2026');
      expect(formatShortDate(SERVER_DAY)).toBe('6/9/2026');
      expect(formatShortDate('2026-06-09')).toBe('6/9/2026');
      expect(formatDateWith(SERVER_DAY, { month: 'short', day: 'numeric', year: 'numeric' })).toBe('Jun 9, 2026');
    });

    it('lib/dates formatDate shows the named day (was Jun 8 west of UTC)', () => {
      expect(datesFormatDate(SERVER_DAY)).toBe('Jun 9, 2026');
      expect(datesFormatDate(null)).toBe('—');
      expect(datesFormatDate('not a date')).toBe('not a date');
    });

    it('lib/utils formatDate shows the named day', () => {
      expect(utilsFormatDate(SERVER_DAY)).toBe('06/09/2026');
      expect(utilsFormatDate('2026-06-09')).toBe('06/09/2026');
      expect(utilsFormatDate(null)).toBe('');
    });

    it('reports fmtDate shows the named day (was 6/8/2026 west of UTC)', () => {
      expect(reportFmtDate(SERVER_DAY)).toBe('6/9/2026');
      expect(reportFmtDate('2026-06-09')).toBe('6/9/2026');
      expect(reportFmtDate(null)).toBe('');
    });

    it('real instants keep local-time display', () => {
      const instant = '2026-06-09T03:30:00.000Z';
      const local = new Date(instant);
      const expected = `${local.getMonth() + 1}/${local.getDate()}/${local.getFullYear()}`;
      expect(formatShortDate(instant)).toBe(expected);
      expect(reportFmtDate(instant)).toBe(expected);
      expect(toDisplayDate(instant)!.getTime()).toBe(local.getTime());
      expect(utilsFormatDate(instant, 'yyyy-MM-dd HH:mm')).toBe(
        `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')} ${String(local.getHours()).padStart(2, '0')}:30`,
      );
    });

    it('audit-trail day bounds cover the whole local day', () => {
      const from = new Date(localDayStartIso('2026-06-09')!);
      const to = new Date(localDayEndIso('2026-06-09')!);
      expect(from.getTime()).toBe(new Date(2026, 5, 9, 0, 0, 0, 0).getTime());
      expect(to.getTime()).toBe(new Date(2026, 5, 9, 23, 59, 59, 999).getTime());
      const noon = new Date(2026, 5, 9, 12);
      expect(noon >= from && noon <= to).toBe(true);
      expect(new Date(2026, 5, 8, 20) < from).toBe(true);
      expect(localDayStartIso('')).toBeUndefined();
      expect(localDayEndIso('garbage')).toBeUndefined();
    });
  });
}

describe('isCalendarDay', () => {
  it('accepts date-only and UTC-midnight forms only', () => {
    expect(isCalendarDay('2026-06-09')).toBe(true);
    expect(isCalendarDay('2026-06-09T00:00:00.000Z')).toBe(true);
    expect(isCalendarDay('2026-06-09T00:00:00Z')).toBe(true);
    expect(isCalendarDay('2026-06-09T00:00:00+00:00')).toBe(true);
    expect(isCalendarDay('2026-06-09T00:00:01.000Z')).toBe(false);
    expect(isCalendarDay('2026-06-09T00:00:00-05:00')).toBe(false);
  });
});

describe('invoice live line math (lib/invoiceLineMath.ts)', () => {
  const line = (p: Partial<LiveLineInput>): LiveLineInput => ({ kind: 'income', quantity: '1', rate: '0', taxable: true, ...p });

  it('15% discount of 10.10 is -1.52 (float math saved -1.51)', () => {
    const t = liveLineTotals([line({ rate: '10.10' }), line({ kind: 'discount', rate: '15', discountPercent: true })]);
    expect(toAmountString(t.amounts[1])).toBe('-1.52');
    expect(toAmountString(t.subtotal)).toBe('8.58');
    expect(t.amounts[1].toNumber().toFixed(2)).toBe('-1.52'); // the payload expression
  });

  it('50% discount of 2.01 is -1.01 (float math saved -1.00)', () => {
    const t = liveLineTotals([line({ rate: '2.01' }), line({ kind: 'discount', rate: '50', discountPercent: true })]);
    expect(toAmountString(t.amounts[1])).toBe(toAmountString(Money.mul('2.01', '-0.5')));
    expect(toAmountString(t.amounts[1])).toBe('-1.01');
  });

  it('line amounts round to cents like the server; subtotal lines carry and reset the group', () => {
    const t = liveLineTotals([
      line({ quantity: '1.5', rate: '3.33' }), // 4.995 -> 5.00
      line({ kind: 'subtotal' }),
      line({ quantity: '3', rate: '0.1' }), // 0.30
      line({ kind: 'discount', rate: '10', discountPercent: true }), // 10% of the new group only
    ]);
    expect(t.amounts.map((a) => toAmountString(a))).toEqual(['5.00', '5.00', '0.30', '-0.03']);
    expect(toAmountString(t.subtotal)).toBe('5.27');
  });

  it('flat discount, payment, manual tax and non-taxable lines', () => {
    const t = liveLineTotals([
      line({ quantity: '2', rate: '50' }),
      line({ rate: '20', taxable: false }),
      line({ kind: 'discount', quantity: '', rate: '5' }),
      line({ kind: 'payment', rate: '30' }),
      line({ kind: 'sales_tax', rate: '4.25' }),
    ]);
    expect(toAmountString(t.subtotal)).toBe('115.00');
    expect(toAmountString(t.taxableSubtotal)).toBe('95.00');
    expect(toAmountString(t.payments)).toBe('30.00');
    expect(toAmountString(t.manualTax)).toBe('4.25');
  });

  it('typedNumber treats blank / partial input like parseFloat || 0', () => {
    expect(typedNumber('').toString()).toBe('0');
    expect(typedNumber('abc').toString()).toBe('0');
    expect(typedNumber(' 12.5 ').toString()).toBe('12.5');
    expect(typedNumber('12abc').toString()).toBe('12');
  });
});

for (const tz of ['America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
  describe(`form date defaults in ${tz}`, () => {
    beforeEach(() => {
      process.env.TZ = tz;
    });

    it('todayISO is the LOCAL calendar date (UTC date was tomorrow on US evenings)', () => {
      // 8:30pm Oct 16 in New York = 00:30Z Oct 17
      const now = new Date('2026-10-17T00:30:00.000Z');
      const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      expect(todayISO(now)).toBe(expected);
      if (tz === 'America/New_York' || tz === 'America/Los_Angeles') expect(todayISO(now)).toBe('2026-10-16');
      if (tz === 'Asia/Tokyo' || tz === 'UTC') expect(todayISO(now)).toBe('2026-10-17');
      expect(localDateISO(new Date(2026, 0, 5))).toBe('2026-01-05');
      expect(reportTodayStr()).toBe(todayISO());
    });

    it('firstOfNextMonthISO matches the server defaultReversalDate (UTC year-month)', () => {
      expect(firstOfNextMonthISO('2026-07-01T00:00:00.000Z')).toBe('2026-08-01'); // was 2026-07-01 west of UTC
      expect(firstOfNextMonthISO('2026-07-31T00:00:00.000Z')).toBe('2026-08-01');
      expect(firstOfNextMonthISO('2026-12-15')).toBe('2027-01-01');
      expect(firstOfNextMonthISO('')).toBe('');
      // Same answer as lib/services/journal.ts defaultReversalDate for the stored date.
      const stored = new Date('2026-07-01T00:00:00.000Z');
      const server = new Date(Date.UTC(stored.getUTCFullYear(), stored.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      expect(firstOfNextMonthISO(stored.toISOString())).toBe(server);
    });
  });
}
