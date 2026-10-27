/**
 * Review round 5 (team uib): navigation helpers.
 *
 *  - Security (/security?challenge=1&next=…, where sign-in sends someone without a challenge
 *    question) only refused a literal "//" prefix, so next=/\evil.com — which the browser opens as
 *    //evil.com — sent the person to another site after saving their question. The page now uses
 *    the shared ?next= check (lib/safeNext.ts, from the security review), which resolves the
 *    target the way the browser will; these are uib's cases for it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { safeNext } from './safeNext';

describe('safeNext (?next= targets)', () => {
  it('keeps paths inside the app, with their query and hash', () => {
    expect(safeNext('/dashboard')).toBe('/dashboard');
    expect(safeNext('/invoices?new=1')).toBe('/invoices?new=1');
    expect(safeNext('/help#fix-a-mistake')).toBe('/help#fix-a-mistake');
    expect(safeNext('/reports/std/profit-loss?dates=this_month&basis=cash')).toBe('/reports/std/profit-loss?dates=this_month&basis=cash');
  });

  it('refuses anything a browser would open on another site', () => {
    const backslash = String.fromCharCode(92);
    for (const bad of [
      '//evil.com',
      `/${backslash}evil.com`, // the browser opens /\evil.com as //evil.com
      `/${backslash}/evil.com`,
      `${backslash}${backslash}evil.com`,
      '/\t/evil.com', // tabs and line breaks are dropped from URLs
      '/\n/evil.com',
      'https://evil.com',
      'javascript:alert(1)',
      'evil.com',
      '',
      null,
      undefined,
    ]) {
      expect(safeNext(bad as string | null | undefined), String(bad)).toBe('/dashboard');
    }
    expect(safeNext('//evil.com', '/login')).toBe('/login');
  });

  it('the Security page uses it for ?next=', () => {
    const src = fs.readFileSync('app/security/page.tsx', 'utf8');
    expect(src).toContain("from '@/lib/safeNext'");
    expect(src).toContain('safeNext(');
  });
});
