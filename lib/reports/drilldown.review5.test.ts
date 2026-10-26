/**
 * Review round 5 — the drill-down page's "Back" link only ever goes back inside the app.
 *
 * safeBackHref refused '//host' and backslashes, but browsers drop tabs and line breaks from a
 * URL before parsing it, so '/\t/evil.example' (or '/\n/evil.example') passed the check and
 * became the protocol-relative '//evil.example': a shared drill-down link could send the reader
 * to another site.
 */
import { describe, expect, it } from 'vitest';
import { safeBackHref } from './drilldown';

describe('safeBackHref', () => {
  it('refuses paths a browser would turn into another host', () => {
    for (const bad of ['/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '/ /evil.example', '//evil.example', '/\\evil.example', 'https://evil.example']) {
      expect(safeBackHref(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps ordinary report links', () => {
    expect(safeBackHref('/reports/std/profit-loss?from=2026-01-01&to=2026-03-31')).toBe('/reports/std/profit-loss?from=2026-01-01&to=2026-03-31');
    expect(safeBackHref('/reports/std/general-ledger?memo=Rent%20Jan')).toBe('/reports/std/general-ledger?memo=Rent%20Jan');
  });
});
