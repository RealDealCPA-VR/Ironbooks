/**
 * Review round 5 (team uib): pages whose data could not be loaded.
 *
 *  - Privacy & Network, Multi-user and Users & Roles > Password rules showed their loading
 *    skeleton ("Loading password rules…") for ever when the first load failed (server restarting,
 *    the host connection dropped), with no way to retry short of reloading the window; Multi-user
 *    also raised the same error toast again every 30 seconds while it kept polling. They now say
 *    the page could not be loaded and offer Try again; Multi-user notes a failed refresh once,
 *    on the page.
 *  - Time Tracking dated new entries with the day the page was first loaded (stale after midnight).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LoadFailed from '@/components/LoadFailed';

const src = (f: string) => fs.readFileSync(f, 'utf8');

describe('LoadFailed', () => {
  it('says what failed and offers Try again', () => {
    const html = renderToStaticMarkup(createElement(LoadFailed, { message: 'The server is restarting.', onRetry: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('This page could not be loaded.');
    expect(html).toContain('The server is restarting.');
    expect(html).toContain('Try again');
  });
});

describe('pages show a failed load instead of loading for ever', () => {
  it('Privacy & Network', () => {
    const s = src('app/privacy/page.tsx');
    expect(s).toMatch(/loadError \? <LoadFailed[^>]*onRetry=\{\(\) => void load\(\)\}/);
    expect(s).toContain('else setLoadError(msg)');
  });

  it('Multi-user: no toast on every 30-second refresh; a failed first load offers Try again', () => {
    const s = src('app/multi-user/page.tsx');
    const load = s.slice(s.indexOf('const load = useCallback'), s.indexOf('const retry'));
    expect(load).not.toContain('toast(');
    expect(load).toContain('setLoadError(');
    expect(s).toMatch(/loadError \? <LoadFailed/);
  });

  it('Users & Roles > Password rules', () => {
    const s = src('app/users/PasswordPolicyEditor.tsx');
    expect(s).toMatch(/loadError \? \(\s*<LoadFailed/);
  });
});

// ---------------------------------------------------------------------------
// "Today" worked out once, when the page's code first loaded
// ---------------------------------------------------------------------------
//
// The desktop app stays open for days. Time Tracking's Log Time form took its date from a constant
// computed when the page's code was first loaded, so after midnight every new entry defaulted to
// the day before (or the day the app was started); Process Payroll Forms likewise kept the year it
// was opened in. Defaults like these must be worked out when the form opens.


/** Pages and components team uib owns. */
const OWNED = [
  'app/dashboard', 'app/reports', 'app/lists', 'app/settings', 'app/users', 'app/security', 'app/privacy', 'app/backup',
  'app/company-file', 'app/multi-user', 'app/companies', 'app/accountant', 'app/templates', 'app/doc-numbers',
  'app/currencies', 'app/budgets', 'app/jobs', 'app/leads', 'app/letters', 'app/mileage', 'app/time-tracking',
  'app/employees', 'app/pay-runs', 'app/pay-stubs', 'app/payroll-forms', 'app/payroll-tax', 'app/portal', 'app/qb-import',
  'app/merge', 'app/onboarding', 'app/sandbox', 'app/m', 'components/AppShell.tsx', 'components/KeyboardCommands.tsx',
  'components/CommandPalette.tsx', 'components/Help.tsx', 'components/WindowTitleBar.tsx', 'components/AppearancePicker.tsx',
];

function files(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isFile()) return /\.tsx?$/.test(p) ? [p] : [];
  return fs.readdirSync(p).flatMap((e) => files(path.join(p, e)));
}

/** Module-level `const X = todayISO()|new Date(…` or a module-level object literal using them. */
function moduleLevelToday(file: string): string[] {
  const hits: string[] = [];
  let inTop: number | null = null;
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((l, i) => {
      if (/^(export )?const [A-Za-z_$][\w$]*(: [^=]+)? = (\{|\[)\s*$/.test(l)) inTop = i;
      else if (inTop !== null && /^[}\]]/.test(l)) inTop = null;
      if (/^(export )?const [A-Za-z_$][\w$]*(: [^=]+)? = (todayISO\(\)|new Date\()/.test(l) || (inTop !== null && /todayISO\(\)|new Date\(\)/.test(l))) {
        hits.push(`${file}:${i + 1}: ${l.trim()}`);
      }
    });
  return hits;
}

describe('date defaults are worked out when a form opens', () => {
  it('no page keeps "today" or "this year" from when its code was loaded', () => {
    // Employees: EMPTY_PAYROLL_FORM's date is replaced with today's whenever the form opens.
    const allowed = new Set(['app/employees/page.tsx']);
    const hits = OWNED.flatMap(files)
      .filter((f) => !allowed.has(f.split(path.sep).join('/')))
      .flatMap(moduleLevelToday);
    expect(hits).toEqual([]);
  });

  it('Time Tracking dates a new entry today, every time the form opens', () => {
    const s = src('app/time-tracking/page.tsx');
    expect(s).toContain('const emptyForm = (): LogTimeForm => ({');
    expect(s).not.toMatch(/setForm\(emptyForm\)/);
  });
});
