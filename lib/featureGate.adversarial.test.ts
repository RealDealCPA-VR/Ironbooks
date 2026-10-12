/**
 * P1 setup — TESTER (adversarial). A feature switch that hides a page must also block the
 * saves that page makes; otherwise "turned off" is cosmetic. Also checks the pure My
 * Preferences helpers against QB edge cases.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_COMPANY_PREFERENCES,
  FEATURE_GATES,
  blockingFeatureGate,
  featureGateForPage,
  transactionDateWarning,
  type FeatureKey,
} from './preferences';
import { autoDecimal, nextJournalNumber, promptsBeforeSave, transactionTarget } from './prefBehaviors';

const allOff = {
  ...DEFAULT_COMPANY_PREFERENCES,
  ...Object.fromEntries(FEATURE_GATES.map((g) => [g.key, false])),
} as typeof DEFAULT_COMPANY_PREFERENCES;
const only = (key: FeatureKey) => ({ ...DEFAULT_COMPANY_PREFERENCES, [key]: false });

describe('feature gates: hidden page => its API saves are blocked too', () => {
  it('BUG: every gated page whose API lives at /api/<same path> blocks saves there', () => {
    const leaks: string[] = [];
    for (const g of FEATURE_GATES) {
      for (const p of g.pages) {
        const apiDir = path.join(process.cwd(), 'app', 'api', ...p.split('/').filter(Boolean));
        if (!fs.existsSync(apiDir) || p.startsWith('/reports/')) continue; // reports are reads
        if (!blockingFeatureGate('/api' + p, only(g.key), 'POST')) leaks.push(`${g.key}: page ${p} hidden but POST /api${p} saves`);
      }
    }
    // Known leak: /item-receipts page is hidden with purchase orders off, /api/item-receipts is not gated.
    expect(leaks).toEqual([]);
  });

  it('BUG: purchase orders off blocks "create purchase orders from the reorder list" even with inventory on', () => {
    // /api/inventory/reorder/create-po is only matched against the FIRST gate (inventory), so
    // with POs off and inventory on it still creates purchase orders.
    expect(blockingFeatureGate('/api/inventory/reorder/create-po', only('purchaseOrdersEnabled'), 'POST')?.key).toBe(
      'purchaseOrdersEnabled',
    );
  });

  it('with every feature off, reads stay open and unrelated saves are never blocked', () => {
    for (const g of FEATURE_GATES) for (const a of g.apis) expect(blockingFeatureGate(a, allOff, 'GET')).toBeNull();
    for (const a of ['/api/invoices', '/api/bills', '/api/journal-entries', '/api/payments', '/api/company', '/api/preferences']) {
      expect(blockingFeatureGate(a, allOff, 'POST'), a).toBeNull();
    }
    // Lookalike prefixes are not swallowed.
    expect(blockingFeatureGate('/api/estimates-followup-x', allOff, 'POST')).toBeNull();
    expect(featureGateForPage('/estimatesx')).toBeNull();
    // Method case does not open a hole.
    expect(blockingFeatureGate('/api/estimates', allOff, 'post')).not.toBeNull();
    expect(blockingFeatureGate('/api/estimates', allOff, 'get')).toBeNull();
  });
});

describe('date warnings (Accounting preference) edge cases', () => {
  const p = { warnPastDatesEnabled: true, warnPastDays: 90, warnFutureDatesEnabled: true, warnFutureDays: 30 };
  it('exactly N days away is inside the window; N+1 warns (across a leap day)', () => {
    expect(transactionDateWarning('2024-01-31', p, '2024-04-30')).toBeNull(); // 90 days before
    expect(transactionDateWarning('2024-01-30', p, '2024-04-30')).toMatch(/90 days in the past/);
    expect(transactionDateWarning('2024-03-01', { ...p, warnFutureDays: 1 }, '2024-02-28')).toMatch(/future/); // 2 days
    expect(transactionDateWarning('2024-02-29', { ...p, warnFutureDays: 1 }, '2024-02-28')).toBeNull();
  });
  it('zero-day window warns for anything but today; off means never', () => {
    const z = { ...p, warnPastDays: 0, warnFutureDays: 0 };
    expect(transactionDateWarning('2026-06-15', z, '2026-06-15')).toBeNull();
    expect(transactionDateWarning('2026-06-14', z, '2026-06-15')).not.toBeNull();
    expect(transactionDateWarning('1999-01-01', { ...p, warnPastDatesEnabled: false }, '2026-06-15')).toBeNull();
  });
});

describe('My Preferences helpers', () => {
  it('auto decimal point: cents always two digits, signs and non-digits left alone', () => {
    expect(autoDecimal('1234')).toBe('12.34');
    expect(autoDecimal('5')).toBe('0.05');
    expect(autoDecimal('0')).toBe('0.00');
    expect(autoDecimal('-7')).toBe('-0.07');
    expect(autoDecimal('100000')).toBe('1000.00');
    expect(autoDecimal('12.5')).toBe('12.5'); // user typed the point: keep it
    expect(autoDecimal('1,234')).toBe('1,234');
    expect(autoDecimal('')).toBe('');
  });

  it('next journal entry number keeps prefix and zero padding, ignores reversals and blanks', () => {
    expect(nextJournalNumber([])).toBe('1');
    expect(nextJournalNumber([null, '', 'REV of #12'])).toBe('1');
    expect(nextJournalNumber(['GJ-0099', 'GJ-0007'])).toBe('GJ-0100');
    expect(nextJournalNumber(['9', '10', 'REV of #50'])).toBe('11');
    expect(nextJournalNumber(['JE-999'])).toBe('JE-1000');
  });

  it('warn when editing: only edits of a recorded transaction, never creates, deletes or status flips', () => {
    const company = DEFAULT_COMPANY_PREFERENCES;
    const my = { warnWhenEditing: true };
    const today = '2026-06-15';
    expect(promptsBeforeSave({ method: 'PUT', path: '/api/invoices/abc', body: { lines: [] } }, company, my, today).map((x) => x.kind)).toEqual(['edit']);
    expect(promptsBeforeSave({ method: 'POST', path: '/api/invoices', body: { lines: [] } }, company, my, today)).toEqual([]);
    expect(promptsBeforeSave({ method: 'DELETE', path: '/api/invoices/abc', body: undefined }, company, my, today)).toEqual([]);
    expect(promptsBeforeSave({ method: 'PATCH', path: '/api/invoices/abc', body: { sent: true } }, company, my, today)).toEqual([]);
    expect(promptsBeforeSave({ method: 'PUT', path: '/api/invoices/abc', body: { lines: [] } }, company, { warnWhenEditing: false }, today)).toEqual([]);
    // Nested action routes are not "the record" (e.g. /void, /email).
    expect(transactionTarget('/api/invoices/abc/void')).toBeNull();
    expect(transactionTarget('/api/payroll/pay-runs/r1')).toEqual({ base: '/api/payroll/pay-runs', record: true });
  });
});
