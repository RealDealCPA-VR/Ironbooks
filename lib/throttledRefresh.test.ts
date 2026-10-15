/**
 * Sidebar "Needs attention" badge refetch throttle (components/AttentionBadge.tsx): navigation,
 * focus and timer refreshes run at most once per 30 s (one trailing catch-up), inbox changes run
 * at once, and two fetches never overlap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTENTION_COUNT_MIN_INTERVAL_MS, createThrottledRefresh } from './throttledRefresh';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('createThrottledRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs routine refreshes at most once per 30 seconds, with one trailing catch-up', async () => {
    expect(ATTENTION_COUNT_MIN_INTERVAL_MS).toBe(30_000);
    const run = vi.fn(async () => undefined);
    const r = createThrottledRefresh(run);
    expect(r.request()).toBe(true); // first load
    await flush();
    // Ten page navigations / focus events in quick succession: no extra fetch yet.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(1_000);
      expect(r.request()).toBe(false);
    }
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    // ...but exactly one catch-up when the 30 seconds are up.
    vi.advanceTimersByTime(20_000);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    // After a quiet spell a routine refresh runs straight away.
    expect(r.request()).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(3);
    r.cancel();
  });

  it('runs forced refreshes (the inbox changed something) at once', async () => {
    const run = vi.fn(async () => undefined);
    const r = createThrottledRefresh(run);
    r.request(true);
    await flush();
    vi.advanceTimersByTime(1_000);
    expect(r.request(true)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    r.cancel();
  });

  it('never overlaps fetches; a forced request during one runs right after it', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((res) => (finish = res)));
    const r = createThrottledRefresh(run);
    r.request(true);
    await flush();
    expect(r.request(true)).toBe(false);
    expect(r.request()).toBe(false);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    finish();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    r.cancel();
  });

  it('a failing fetch does not wedge it, and cancel drops the pending catch-up', async () => {
    const run = vi.fn(async () => {
      throw new Error('offline');
    });
    const r = createThrottledRefresh(run, { minIntervalMs: 10_000 });
    r.request();
    await flush();
    expect(r.request(true)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    r.request(); // schedules a catch-up...
    r.cancel(); // ...that never runs
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(r.request(true)).toBe(false);
  });
});
