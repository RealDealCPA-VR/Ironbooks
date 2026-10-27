/**
 * Review round 5 — lib/preferences.ts helpers:
 *  zonedDayBound turns a calendar day into the instants it starts / ends in a time zone, so
 *  "when it happened" report filters (audit trail timestamps) follow the company's calendar.
 */
import { describe, expect, it } from 'vitest';
import { zonedDayBound } from './preferences';

describe('zonedDayBound', () => {
  it('New York day bounds (EDT and EST)', () => {
    expect(zonedDayBound('2026-10-26', 'America/New_York')!.toISOString()).toBe('2026-10-26T04:00:00.000Z');
    expect(zonedDayBound('2026-10-26', 'America/New_York', true)!.toISOString()).toBe('2026-10-27T03:59:59.999Z');
    expect(zonedDayBound('2026-12-01', 'America/New_York')!.toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });

  it('DST changeover days are 23 / 25 hours long', () => {
    // 2026-03-08: clocks spring forward in New York (starts EST, ends EDT).
    expect(zonedDayBound('2026-03-08', 'America/New_York')!.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedDayBound('2026-03-08', 'America/New_York', true)!.toISOString()).toBe('2026-03-09T03:59:59.999Z');
    // 2026-11-01: clocks fall back (starts EDT, ends EST).
    expect(zonedDayBound('2026-11-01', 'America/New_York')!.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(zonedDayBound('2026-11-01', 'America/New_York', true)!.toISOString()).toBe('2026-11-02T04:59:59.999Z');
  });

  it('east of UTC, UTC, bad zone and bad day', () => {
    expect(zonedDayBound('2026-10-26', 'Asia/Tokyo')!.toISOString()).toBe('2026-10-25T15:00:00.000Z');
    expect(zonedDayBound('2026-10-26', 'UTC')!.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(zonedDayBound('2026-10-26', 'Not/AZone', true)!.toISOString()).toBe('2026-10-26T23:59:59.999Z');
    expect(zonedDayBound('2026-02-30', 'UTC')).toBeUndefined();
    expect(zonedDayBound('yesterday', 'UTC')).toBeUndefined();
  });
});
