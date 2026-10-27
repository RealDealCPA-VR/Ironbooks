/**
 * Review round 5 (security): `?next=` after sign-in / unlock / change password is never an open
 * redirect.
 *
 * The sign-in page followed `?next=` as given (`window.location.href = next`), so
 * `/login?next=javascript:…` ran script in the app as the person who just signed in, and
 * `/login?next=https://evil.example` sent them to a look-alike page. The unlock, change-password
 * and security pages had their own check (`starts with "/" but not "//"`), which `/\evil.example`
 * and `/<tab>/evil.example` pass — browsers read both as `//evil.example`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { safeNext } from './safeNext';

describe('review5: safeNext', () => {
  it('refuses every way of naming another site or a script', () => {
    for (const evil of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      'javascript:alert(document.cookie)',
      'JaVaScRiPt:alert(1)',
      ' /dashboard',
      'data:text/html,<script>alert(1)</script>',
      '',
      null,
      undefined,
    ]) {
      expect(safeNext(evil as string | null)).toBe('/dashboard');
    }
  });

  it('keeps same-app paths, queries and fragments', () => {
    expect(safeNext('/invoices')).toBe('/invoices');
    expect(safeNext('/reports/std/profit-loss?from=2026-01-01&to=2026-03-31')).toBe(
      '/reports/std/profit-loss?from=2026-01-01&to=2026-03-31',
    );
    expect(safeNext('/customers/1#notes')).toBe('/customers/1#notes');
    expect(safeNext('/a/../banking')).toBe('/banking');
  });

  it('can refuse the page itself (no redirect loop) and use a page-specific fallback', () => {
    expect(safeNext('/unlock?next=/x', '/', ['/unlock'])).toBe('/');
    expect(safeNext('/change-password', '/dashboard', ['/change-password'])).toBe('/dashboard');
    expect(safeNext('/unlocked', '/', ['/unlock'])).toBe('/unlocked');
  });

  it('every page that follows ?next= uses the shared check', () => {
    for (const page of ['app/login/page.tsx', 'app/unlock/page.tsx', 'app/change-password/page.tsx', 'app/security/page.tsx']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), page), 'utf8');
      expect(src, page).toMatch(/from '@\/lib\/safeNext'/);
      expect(src, page).not.toMatch(/function safeNext\(/);
      // The raw parameter is never followed as-is.
      expect(src, page).not.toMatch(/get\('next'\)\s*\|\|/);
    }
  });
});
