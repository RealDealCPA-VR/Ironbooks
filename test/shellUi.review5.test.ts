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
 *  - Ctrl+N / Ctrl+S did nothing on Time Tracking, Mileage and in Add user (unrecognised labels).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LoadFailed from '@/components/LoadFailed';
import { pickShortcutButton, type ShortcutButton } from '@/lib/shortcuts';
import { expectAllPassed, runDomFile } from './domHarness';

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
  // The real pages in a browser window (test/dom/loadFailed.dom.tsx): the first load answers 500,
  // then Try again reaches a working server. Multi-user's 30-second refresh timer is caught and
  // fired by the test, with the app's Toaster mounted to see any toast.
  it('Privacy & Network, Multi-user and Password rules: "could not be loaded" + Try again; Multi-user refresh failures raise no toast', async () => {
    expectAllPassed(await runDomFile('test/dom/loadFailed.dom.tsx'), [
      'Privacy & Network: a failed first load offers Try again, which loads the page',
      'Multi-user: a failed first load offers Try again, which loads the page',
      'Multi-user: a failed 30-second refresh is noted once on the page, never as a toast',
      'Users & Roles > Password rules: a failed load offers Try again, which loads the rules',
    ]);
  }, 180_000);
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

// ---------------------------------------------------------------------------
// Ctrl+N / Ctrl+S on Time Tracking, Mileage and Users
// ---------------------------------------------------------------------------
//
// The form keys find buttons by label (New…/Add…, Save/Record/Post/Create…). "Log Time", "Log
// Miles" and "Add user" (in its dialog) matched neither, so Ctrl+N on Time Tracking and Mileage and
// Ctrl+S / Alt+A / Ctrl+Enter in their forms did nothing. The buttons now say what they are
// (data-shortcut).


/** The buttons of rendered markup as the shortcut logic sees them (label + data-shortcut). */
function buttonsOf(html: string): ShortcutButton[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({
    label: inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    shortcut: /data-shortcut="([^"]+)"/.exec(attrs)?.[1] ?? null,
    disabled: /\sdisabled(=|\s|$)/.test(attrs),
  }));
}

describe('the form keys find these pages’ buttons', () => {
  it('Ctrl+N on Time Tracking opens Log Time; on Mileage, Log Miles', async () => {
    const { default: TimeTrackingPage } = await import('@/app/time-tracking/page');
    const { default: MileagePage } = await import('@/app/mileage/page');
    for (const [Page, label] of [
      [TimeTrackingPage, 'Log Time'],
      [MileagePage, 'Log Miles'],
    ] as const) {
      const buttons = buttonsOf(renderToStaticMarkup(createElement(Page)));
      const i = pickShortcutButton(buttons, 'new');
      expect(i, label).toBeGreaterThanOrEqual(0);
      expect(buttons[i].label).toBe(label);
    }
  });

  it('Ctrl+S in their forms and in Add user presses the form’s button', () => {
    expect(src('app/time-tracking/page.tsx')).toMatch(/form="log-time-form" loading=\{saving\} data-shortcut="save"/);
    expect(src('app/mileage/page.tsx')).toMatch(/onClick=\{handleLog\} loading=\{logSaving\} data-shortcut="save"/);
    expect(src('app/users/page.tsx')).toMatch(/roleKeys\.length === 0\} data-shortcut="save"/);
    // And what the label alone would have given:
    expect(pickShortcutButton([{ label: 'Cancel' }, { label: 'Log Time' }], 'save')).toBe(-1);
    expect(pickShortcutButton([{ label: 'Cancel' }, { label: 'Add user' }], 'save')).toBe(-1);
  });
});
