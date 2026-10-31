/** QuickBooks-style partial dates typed into a date field (parseTypedDate, lib/shortcuts.ts). */
import { describe, expect, it } from 'vitest';
import { parseTypedDate } from '@/lib/shortcuts';
import { resolveMyPreferences } from '@/lib/preferences';
import { myPreferencesSchema } from '@/lib/validation/prefs';

const TODAY = '2026-10-31';

describe('parseTypedDate', () => {
  it('fills in the current year for month and day', () => {
    expect(parseTypedDate('10/24', TODAY)).toBe('2026-10-24');
    expect(parseTypedDate('10-24', TODAY)).toBe('2026-10-24');
    expect(parseTypedDate('1024', TODAY)).toBe('2026-10-24');
    expect(parseTypedDate('324', TODAY)).toBe('2026-03-24');
    expect(parseTypedDate('3/5', TODAY)).toBe('2026-03-05');
  });
  it('a day alone is that day of the current month', () => {
    expect(parseTypedDate('24', TODAY)).toBe('2026-10-24');
    expect(parseTypedDate('5', TODAY)).toBe('2026-10-05');
  });
  it('takes two- and four-digit years and full dates', () => {
    expect(parseTypedDate('10/24/25', TODAY)).toBe('2025-10-24');
    expect(parseTypedDate('10/24/2025', TODAY)).toBe('2025-10-24');
    expect(parseTypedDate('102425', TODAY)).toBe('2025-10-24');
    expect(parseTypedDate('10242025', TODAY)).toBe('2025-10-24');
    expect(parseTypedDate('2025-10-24', TODAY)).toBe('2025-10-24');
  });
  it('refuses what is not a date', () => {
    for (const bad of ['', '13/1', '2/30', '0/5', '10/0', 'abc', '12345', '1/2/345', '10/24x']) {
      expect(parseTypedDate(bad, TODAY), bad).toBeNull();
    }
  });
});

describe('Screen density preference', () => {
  it('defaults to comfortable, keeps compact, refuses anything else', () => {
    expect(resolveMyPreferences({}).density).toBe('comfortable');
    expect(resolveMyPreferences({ density: 'compact' }).density).toBe('compact');
    expect(resolveMyPreferences({ density: 'tiny' }).density).toBe('comfortable');
    expect(myPreferencesSchema.safeParse({ density: 'compact' }).success).toBe(true);
    expect(myPreferencesSchema.safeParse({ density: 'tiny' }).success).toBe(false);
  });
});
