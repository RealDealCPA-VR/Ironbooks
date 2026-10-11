/**
 * Pure Preferences model: defaults, tolerant resolution of stored settings, and the helpers
 * forms/services use (date warnings, due dates, account labels, merge fields, pay periods).
 */
import { describe, expect, it } from 'vitest';
import {
  COMPANY_PREFERENCE_KEYS,
  DEFAULT_COMPANY_PREFERENCES,
  DEFAULT_REMINDERS,
  MY_PREFERENCE_KEYS,
  PREFERENCE_CATEGORIES,
  addDaysIso,
  defaultPeriodHours,
  featureHiddenPaths,
  dueDateForTerms,
  fillMergeFields,
  formatAccountLabel,
  resolveCompanyPreferences,
  resolveMyPreferences,
  todayInTimeZone,
  transactionDateWarning,
} from './preferences';
import { FIELD_META } from './preferenceFields';
import { navGroups } from './nav';

describe('resolveCompanyPreferences', () => {
  it('returns every default for empty / garbage settings', () => {
    expect(resolveCompanyPreferences(null)).toEqual(DEFAULT_COMPANY_PREFERENCES);
    expect(resolveCompanyPreferences('nope')).toEqual(DEFAULT_COMPANY_PREFERENCES);
    expect(resolveCompanyPreferences([])).toEqual(DEFAULT_COMPANY_PREFERENCES);
  });

  it('overlays stored values of the right type and ignores wrong types', () => {
    const p = resolveCompanyPreferences({
      reportBasis: 'cash',
      accountNumbersEnabled: false,
      warnPastDays: 30,
      warnFutureDays: '45', // wrong type -> default
      defaultCustomerTerms: 'net_15',
      defaultVendorTerms: 'net_999', // unknown -> default
      defaultCheckAccountId: 'abc',
      defaultExpenseAccountId: '', // '' clears an account pref
      timezone: 'Europe/London',
    });
    expect(p.reportBasis).toBe('cash');
    expect(p.accountNumbersEnabled).toBe(false);
    expect(p.warnPastDays).toBe(30);
    expect(p.warnFutureDays).toBe(DEFAULT_COMPANY_PREFERENCES.warnFutureDays);
    expect(p.defaultCustomerTerms).toBe('net_15');
    expect(p.defaultVendorTerms).toBe('net_30');
    expect(p.defaultCheckAccountId).toBe('abc');
    expect(p.defaultExpenseAccountId).toBeNull();
    expect(p.timezone).toBe('Europe/London');
  });

  it('merges reminders and send-forms per key', () => {
    const p = resolveCompanyPreferences({
      reminders: { overdueInvoices: { mode: 'list', days: 3.7 }, billsToPay: { mode: 'bogus', days: -5 } },
      sendForms: { invoice: { subject: 'Hi {{number}}', body: '' } },
    });
    expect(p.reminders.overdueInvoices).toEqual({ mode: 'list', days: 4 });
    expect(p.reminders.billsToPay).toEqual({ mode: DEFAULT_REMINDERS.billsToPay.mode, days: 0 });
    expect(p.reminders.checksToPrint).toEqual(DEFAULT_REMINDERS.checksToPrint);
    expect(p.sendForms.invoice.subject).toBe('Hi {{number}}');
    expect(p.sendForms.invoice.body).toBe(DEFAULT_COMPANY_PREFERENCES.sendForms.invoice.body);
  });

  it('my preferences resolve the same way', () => {
    const m = resolveMyPreferences({ spellCheckEnabled: false, defaultDate: 'last', bogus: 1 });
    expect(m.spellCheckEnabled).toBe(false);
    expect(m.defaultDate).toBe('last');
    expect((m as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe('preference catalogue', () => {
  it('every category key is a real preference with UI metadata', () => {
    for (const c of PREFERENCE_CATEGORIES) {
      for (const k of c.company) {
        expect(COMPANY_PREFERENCE_KEYS).toContain(k);
        expect(FIELD_META[k], `FIELD_META.${k}`).toBeTruthy();
      }
      for (const k of c.my) {
        expect(MY_PREFERENCE_KEYS).toContain(k);
        expect(FIELD_META[k], `FIELD_META.${k}`).toBeTruthy();
      }
    }
  });

  it('covers the QB Preferences categories', () => {
    const labels = PREFERENCE_CATEGORIES.map((c) => c.label);
    for (const l of [
      'Accounting',
      'Checking',
      'General',
      'Jobs & Estimates',
      'Items & Inventory',
      'Payments',
      'Reminders',
      'Reports & Graphs',
      'Sales & Customers',
      'Sales Tax',
      'Send Forms',
      'Spelling',
      'Time & Expenses',
      'Multiple Currencies',
    ]) {
      expect(labels).toContain(l);
    }
  });
});

describe('date helpers', () => {
  it('todayInTimeZone respects the zone and falls back on a bad zone', () => {
    const instant = new Date('2026-03-01T03:00:00Z'); // still Feb 28 in New York
    expect(todayInTimeZone('America/New_York', instant)).toBe('2026-02-28');
    expect(todayInTimeZone('Asia/Tokyo', instant)).toBe('2026-03-01');
    expect(todayInTimeZone('Not/AZone', instant)).toBe('2026-03-01');
  });

  it('addDaysIso and dueDateForTerms', () => {
    expect(addDaysIso('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(dueDateForTerms('2026-01-15', 'net_30')).toBe('2026-02-14');
    expect(dueDateForTerms('2026-01-15', 'due_on_receipt')).toBe('2026-01-15');
    expect(dueDateForTerms('2026-01-15', 'mystery')).toBe('');
    expect(dueDateForTerms('', 'net_30')).toBe('');
  });

  it('transactionDateWarning honors both windows and the switches', () => {
    const prefs = { warnPastDatesEnabled: true, warnPastDays: 90, warnFutureDatesEnabled: true, warnFutureDays: 30 };
    expect(transactionDateWarning('2026-06-01', prefs, '2026-06-15')).toBeNull();
    expect(transactionDateWarning('2026-03-01', prefs, '2026-06-15')).toMatch(/90 days in the past/);
    expect(transactionDateWarning('2026-08-01', prefs, '2026-06-15')).toMatch(/30 days in the future/);
    expect(transactionDateWarning('2026-08-01', { ...prefs, warnFutureDatesEnabled: false }, '2026-06-15')).toBeNull();
    expect(transactionDateWarning('garbage', prefs, '2026-06-15')).toBeNull();
  });
});

describe('labels and text', () => {
  it('formatAccountLabel follows account numbers + display preference', () => {
    const a = { code: '6300', name: 'Office Supplies', description: 'Paper & toner' };
    expect(formatAccountLabel(a, { accountNumbersEnabled: true })).toBe('6300 · Office Supplies');
    expect(formatAccountLabel(a, { accountNumbersEnabled: false })).toBe('Office Supplies');
    expect(formatAccountLabel(a, { accountNumbersEnabled: false, accountDisplay: 'description' })).toBe('Paper & toner');
    expect(formatAccountLabel(a, { accountNumbersEnabled: true, accountDisplay: 'both' })).toBe(
      '6300 · Office Supplies (Paper & toner)',
    );
  });

  it('fillMergeFields fills known fields, blanks unknown, case-insensitive', () => {
    expect(fillMergeFields('Hi {{ Customer.Name }}, owe {{balance}} {{nope}}!', { 'customer.name': 'Ann', balance: '$5.00' })).toBe(
      'Hi Ann, owe $5.00 !',
    );
  });

  it('defaultPeriodHours', () => {
    expect(defaultPeriodHours('biweekly', 40)).toBe(80);
    expect(defaultPeriodHours('weekly', 37.5)).toBe(37.5);
    expect(defaultPeriodHours('monthly', 40)).toBeCloseTo(173.33, 2);
  });
});

describe('featureHiddenPaths', () => {
  it('hides nothing with the defaults', () => {
    expect(featureHiddenPaths(DEFAULT_COMPANY_PREFERENCES).size).toBe(0);
  });
  it('turning a feature off hides its pages, and every hidden path is a real sidebar entry', () => {
    const off = featureHiddenPaths({
      ...DEFAULT_COMPANY_PREFERENCES,
      estimatesEnabled: false,
      salesOrdersEnabled: false,
      purchaseOrdersEnabled: false,
      inventoryEnabled: false,
      timeTrackingEnabled: false,
      salesTaxEnabled: false,
    });
    expect(off.has('/estimates')).toBe(true);
    expect(off.has('/purchase-orders')).toBe(true);
    expect(off.has('/currencies')).toBe(false);
    expect(off.has('/invoices')).toBe(false);
    const navPaths = new Set(navGroups.flatMap((g) => g.links.map((l) => l.path)));
    for (const p of off) expect(navPaths.has(p), p).toBe(true);
  });
});
