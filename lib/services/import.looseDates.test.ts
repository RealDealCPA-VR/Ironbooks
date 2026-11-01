/**
 * Feature round (accountant team) — review round 5 leftover (imports): a bank CSV imported with no
 * date format chosen read dates that have no year ("01/31", "Jan 31", "31 Jan") as 2001-01-31, and
 * a bare number ("46053", the Excel serial number a re-saved CSV holds) as the year 46053. A date
 * without its year is now refused with the row number, and an Excel serial number is read as the
 * day it stands for. Failed before the fix.
 */
import { describe, expect, it } from 'vitest';
import { parseCSV } from './import';

const mapping = { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' };
const csv = (date: string) => `Date,Description,Amount\n${date},Coffee,-4.50\n`;

describe('bank CSV dates without a chosen format', () => {
  for (const noYear of ['01/31', 'Jan 31', '31 Jan', '1-31']) {
    it(`"${noYear}" (no year) is refused, never read as 2001`, () => {
      expect(() => parseCSV(csv(noYear), mapping)).toThrow(/row 1.*date/i);
    });
  }

  it('an Excel serial number is the day it stands for (46053 = 2026-01-31)', () => {
    const [row] = parseCSV(csv('46053'), mapping);
    expect(row.date.toISOString().slice(0, 10)).toBe('2026-01-31');
  });

  it('a number that is no plausible date is refused', () => {
    expect(() => parseCSV(csv('123'), mapping)).toThrow(/row 1.*date/i);
    expect(() => parseCSV(csv('2026'), mapping)).toThrow(/row 1.*date/i);
  });

  it('dates with their year still read as before', () => {
    expect(parseCSV(csv('01/31/2026'), mapping)[0].date.toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(parseCSV(csv('2026-01-31'), mapping)[0].date.toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(parseCSV(csv('"Jan 31, 2026"'), mapping)[0].date.toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(parseCSV(csv('31 Jan 2026'), mapping)[0].date.toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(parseCSV(csv('1/31/26'), mapping)[0].date.toISOString().slice(0, 10)).toBe('2026-01-31');
  });
});
