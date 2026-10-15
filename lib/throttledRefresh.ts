/**
 * Throttle for a background refetch (the sidebar's "Needs attention" count): routine triggers
 * (page navigation, window focus, the timer) run at most once per `minIntervalMs`; one that comes
 * too soon is folded into a single trailing refetch when the interval is up, so the number still
 * catches up. `force` (the inbox changed something) always runs at once. Never runs two at once.
 */
export interface ThrottledRefresh {
  /** Ask for a refetch. Returns true when it started now. */
  request(force?: boolean): boolean;
  /** Stop: drop any pending trailing refetch. */
  cancel(): void;
}

export const ATTENTION_COUNT_MIN_INTERVAL_MS = 30_000;

export function createThrottledRefresh(
  run: () => Promise<unknown>,
  opts: { minIntervalMs?: number; now?: () => number } = {},
): ThrottledRefresh {
  const minInterval = opts.minIntervalMs ?? ATTENTION_COUNT_MIN_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  let lastStart = -Infinity;
  let inFlight = false;
  let again = false; // a forced request arrived while one was running
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const start = () => {
    if (trailing) {
      clearTimeout(trailing);
      trailing = null;
    }
    inFlight = true;
    lastStart = now();
    Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (again && !stopped) {
          again = false;
          start();
        }
      });
  };

  return {
    request(force = false) {
      if (stopped) return false;
      if (inFlight) {
        if (force) again = true;
        return false;
      }
      const wait = lastStart + minInterval - now();
      if (force || wait <= 0) {
        start();
        return true;
      }
      if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          if (!stopped && !inFlight) start();
        }, wait);
      }
      return false;
    },
    cancel() {
      stopped = true;
      if (trailing) clearTimeout(trailing);
      trailing = null;
    },
  };
}
