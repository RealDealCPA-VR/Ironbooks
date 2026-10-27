/**
 * IRS standard mileage rate for BUSINESS use, by the date of the trip (pure module: the Mileage
 * page shows the same default the service stores).
 *
 * Source: the IRS standard mileage rate announcement for each year — 2019 58¢, 2020 57.5¢, 2021
 * 56¢, 2022 58.5¢ (Jan–Jun) and 62.5¢ (Jul–Dec, mid-year increase), 2023 65.5¢, 2024 67¢, 2025
 * 70¢, 2026 72.5¢. A trip after the last year listed uses the latest rate; add each new year when
 * the IRS announces it (usually in December).
 */

interface RatePeriod {
  /** First day the rate applies (YYYY-MM-DD). */
  from: string;
  /** Dollars per mile. */
  rate: string;
}

/** Oldest first. */
const IRS_BUSINESS_MILEAGE_RATES: RatePeriod[] = [
  { from: '2019-01-01', rate: '0.58' },
  { from: '2020-01-01', rate: '0.575' },
  { from: '2021-01-01', rate: '0.56' },
  { from: '2022-01-01', rate: '0.585' },
  { from: '2022-07-01', rate: '0.625' },
  { from: '2023-01-01', rate: '0.655' },
  { from: '2024-01-01', rate: '0.67' },
  { from: '2025-01-01', rate: '0.70' },
  { from: '2026-01-01', rate: '0.725' },
];

/**
 * The IRS business mileage rate (dollars per mile, decimal string) for a trip on `date`
 * ('YYYY-MM-DD' or a Date at UTC midnight). Dates before the table use its oldest rate.
 */
export function irsMileageRateFor(date: Date | string | null | undefined): string {
  const day =
    date instanceof Date && !Number.isNaN(date.getTime())
      ? date.toISOString().slice(0, 10)
      : typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)
        ? date.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
  let rate = IRS_BUSINESS_MILEAGE_RATES[0].rate;
  for (const p of IRS_BUSINESS_MILEAGE_RATES) {
    if (p.from <= day) rate = p.rate;
  }
  return rate;
}
