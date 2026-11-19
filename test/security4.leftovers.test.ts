/**
 * Small leftovers of the security work, checked in the source (pages cannot export helpers):
 *  - Report Schedules: a schedule held because internet services are off for this file on this
 *    computer is a wait, not a failure — shown in the warning tone with its message, never red;
 *  - PATCH /api/company/closing-date passes only the validated body (currentPassword is in the
 *    schema now), never fields read from the raw body.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('Report Schedules: a held schedule', () => {
  const page = read('app/reports/schedules/page.tsx');

  it('is shown in the warning tone, failures stay red', () => {
    const fn = /function lastStatusTone\(status: string \| null\)[^{]*\{([\s\S]*?)\n\}/.exec(page);
    expect(fn, 'lastStatusTone').not.toBeNull();
    // Evaluate the helper's body as written (plain conditionals, no types inside).
    const tone = new Function('status', fn![1]) as (s: string | null) => string;
    expect(tone('held')).toBe('warning');
    expect(tone('partial')).toBe('warning');
    expect(tone('ok')).toBe('success');
    expect(tone('failed')).toBe('danger');
    expect(page).toMatch(/<Badge tone=\{lastStatusTone\(s\.lastStatus\)\}>/);
  });

  it('shows its message on the page, not only in a tooltip', () => {
    expect(page).toMatch(/s\.lastStatus === 'held' && s\.lastMessage && <p[^>]*>\{s\.lastMessage\}<\/p>/);
  });
});

describe('PATCH /api/company/closing-date', () => {
  it('hands the service the validated body only', () => {
    const route = read('app/api/company/closing-date/route.ts');
    expect(route).toMatch(/setClosingDate\(ctx, parsed\.data\)/);
    expect(route).not.toMatch(/raw\?\.currentPassword|body as \{ currentPassword/);
  });
});
