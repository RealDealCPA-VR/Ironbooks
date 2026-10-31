/**
 * A fixed clock for the DOM tests: while `atLocalTime` runs, `new Date()` and `Date.now()` start at
 * the given LOCAL date and time of the test window's time zone (the vitest side picks the zone with
 * process.env.TZ before runDomFile) and then run on in real time, so the harness's own timeouts
 * (until) still expire. Dates built from arguments are untouched.
 */
const RealDate = Date;

/** The instant of a local wall-clock time (month 1–12) in the window's time zone. */
export function localInstant(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new RealDate(year, month - 1, day, hour, minute).getTime();
}

/** True when the local calendar year at `ms` differs from the UTC one (a UTC-year bug would show). */
export function straddlesUtcYear(ms: number): boolean {
  const d = new RealDate(ms);
  return d.getFullYear() !== d.getUTCFullYear();
}

export async function atLocalTime<T>(
  [year, month, day, hour = 12, minute = 0]: [number, number, number, number?, number?],
  fn: () => Promise<T>,
): Promise<T> {
  const start = localInstant(year, month, day, hour, minute);
  const realStart = RealDate.now();
  const now = () => start + (RealDate.now() - realStart);
  class FixedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(now());
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static now() {
      return now();
    }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}
