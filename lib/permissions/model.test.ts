/**
 * Pure permission-model tests: normalization, role union, built-in role sanity, per-role
 * request authorization against the route map, and sensitive-field masking.
 */
import { describe, it, expect } from 'vitest';
import {
  AREA_KEYS,
  BUILTIN_ROLES,
  LEGACY_ROLE_MAP,
  builtinRole,
  can,
  isSubset,
  legacyRoleFor,
  normalizeGrant,
  unionRoles,
} from './model';
import { authorizeRequest } from './enforce';
import { maskSensitive } from './mask';

const access = (...keys: string[]) => unionRoles(keys.map((k) => builtinRole(k)!));
const allowed = (keys: string[], method: string, path: string) => {
  try {
    authorizeRequest({ path, method }, access(...keys));
    return true;
  } catch {
    return false;
  }
};

describe('permission model', () => {
  it('expands full and implies view', () => {
    const n = normalizeGrant({ banking: ['full'], customers: ['create'] });
    expect(n.banking).toEqual(['view', 'create', 'modify', 'delete', 'print']);
    expect(n.customers).toEqual(['view', 'create']);
    expect(n.payroll).toEqual([]);
  });

  it('ignores unknown areas/actions', () => {
    const n = normalizeGrant({ bogus: ['full'], banking: ['explode', 'view'] } as never);
    expect(n.banking).toEqual(['view']);
    expect(Object.keys(n).sort()).toEqual([...AREA_KEYS].sort());
  });

  it('has the QB Enterprise predefined roles with unique keys', () => {
    const keys = BUILTIN_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of [
      'admin', 'full_access', 'accountant', 'bookkeeper', 'ar_clerk', 'ap_clerk', 'banking',
      'payroll_processor', 'sales', 'purchasing', 'inventory', 'time_tracking', 'view_only',
      'reports_only', 'external_accountant',
    ]) {
      expect(keys).toContain(k);
    }
    for (const legacy of Object.values(LEGACY_ROLE_MAP)) expect(keys).toContain(legacy);
  });

  it('gives Admin everything, and only Admin manages users', () => {
    const admin = access('admin');
    for (const a of AREA_KEYS) expect(admin.permissions[a]).toHaveLength(5);
    expect(admin.flags).toEqual({ sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true });
    for (const r of BUILTIN_ROLES.filter((x) => x.key !== 'admin')) {
      expect(can(access(r.key), 'users', 'modify'), r.key).toBe(false);
    }
  });

  it('unions multiple roles (permissions and flags)', () => {
    const u = access('ar_clerk', 'payroll_processor');
    expect(can(u, 'customers', 'delete')).toBe(true);
    expect(can(u, 'payroll', 'create')).toBe(true);
    expect(can(u, 'vendors', 'view')).toBe(false);
    expect(u.flags.sensitivePayroll).toBe(true);
    expect(u.roleKeys).toEqual(['ar_clerk', 'payroll_processor']);
    expect(isSubset(access('ar_clerk'), u)).toBe(true);
    expect(isSubset(u, access('ar_clerk'))).toBe(false);
  });

  it('collapses to legacy levels', () => {
    expect(legacyRoleFor(access('admin'), true)).toBe('owner');
    expect(legacyRoleFor(access('admin'), false)).toBe('admin');
    expect(legacyRoleFor(access('view_only'), false)).toBe('viewer');
    expect(legacyRoleFor(access('reports_only'), false)).toBe('viewer');
    expect(legacyRoleFor(access('ar_clerk'), false)).toBe('accountant');
  });
});

describe('request authorization per role', () => {
  it('A/R clerk: customers yes, vendors/journal/financial reports no', () => {
    const k = ['ar_clerk'];
    expect(allowed(k, 'GET', '/api/invoices')).toBe(true);
    expect(allowed(k, 'POST', '/api/invoices')).toBe(true);
    expect(allowed(k, 'GET', '/api/invoices/abc/pdf')).toBe(true);
    expect(allowed(k, 'GET', '/api/reports/ar-aging')).toBe(true);
    expect(allowed(k, 'POST', '/api/bills')).toBe(false);
    expect(allowed(k, 'GET', '/api/bills')).toBe(false);
    expect(allowed(k, 'POST', '/api/journal-entries')).toBe(false);
    expect(allowed(k, 'GET', '/api/reports/profit-loss')).toBe(false);
    expect(allowed(k, 'GET', '/api/reports/general-ledger')).toBe(false);
    expect(allowed(k, 'GET', '/api/users')).toBe(false);
  });

  it('A/P clerk is the mirror image', () => {
    const k = ['ap_clerk'];
    expect(allowed(k, 'POST', '/api/bills')).toBe(true);
    expect(allowed(k, 'DELETE', '/api/bills/abc')).toBe(true);
    expect(allowed(k, 'GET', '/api/reports/ap-aging')).toBe(true);
    expect(allowed(k, 'POST', '/api/invoices')).toBe(false);
  });

  it('union of A/R + A/P clerk can do both', () => {
    const k = ['ar_clerk', 'ap_clerk'];
    expect(allowed(k, 'POST', '/api/bills')).toBe(true);
    expect(allowed(k, 'POST', '/api/invoices')).toBe(true);
    expect(allowed(k, 'GET', '/api/reports/trial-balance')).toBe(false);
  });

  it('View-Only can read but not write', () => {
    const k = ['view_only'];
    expect(allowed(k, 'GET', '/api/invoices')).toBe(true);
    expect(allowed(k, 'GET', '/api/reports/balance-sheet')).toBe(true);
    expect(allowed(k, 'POST', '/api/invoices')).toBe(false);
    expect(allowed(k, 'PATCH', '/api/customers/abc')).toBe(false);
    expect(allowed(k, 'GET', '/api/users')).toBe(false);
  });

  it('Reports Only sees reports, not transactions', () => {
    const k = ['reports_only'];
    expect(allowed(k, 'GET', '/api/reports/profit-loss')).toBe(true);
    expect(allowed(k, 'GET', '/api/payroll/w2')).toBe(true);
    expect(allowed(k, 'GET', '/api/invoices')).toBe(false);
  });

  it('sensitive accounting and file utilities are restricted', () => {
    expect(allowed(['bookkeeper'], 'POST', '/api/journal-entries')).toBe(true);
    expect(allowed(['bookkeeper'], 'DELETE', '/api/journal-entries/abc')).toBe(false);
    expect(allowed(['bookkeeper'], 'POST', '/api/condense')).toBe(false);
    expect(allowed(['accountant'], 'GET', '/api/backup')).toBe(true);
    expect(allowed(['accountant'], 'POST', '/api/backup')).toBe(false); // restore
    expect(allowed(['full_access'], 'POST', '/api/backup')).toBe(true);
    expect(allowed(['full_access'], 'PATCH', '/api/company/closing-date')).toBe(false);
    expect(allowed(['admin'], 'PATCH', '/api/company/closing-date')).toBe(true);
  });

  it('report pages respect report permissions', () => {
    expect(allowed(['ar_clerk'], 'GET', '/reports/profit-loss')).toBe(false);
    expect(allowed(['ar_clerk'], 'GET', '/reports/ar-aging')).toBe(true);
    expect(allowed(['ar_clerk'], 'GET', '/reports')).toBe(true);
    expect(allowed(['time_tracking'], 'GET', '/reports')).toBe(false);
    expect(allowed(['time_tracking'], 'GET', '/dashboard')).toBe(true);
  });

  it('denies unmapped API routes for everyone, Admin included', () => {
    expect(allowed(['admin'], 'GET', '/api/not-a-route')).toBe(false);
    expect(allowed(['admin'], 'DELETE', '/api/customers')).toBe(false);
  });

  it('a request missing the middleware stamp passes only for Admin', () => {
    expect(() => authorizeRequest({ path: null, method: 'GET' }, access('admin'))).not.toThrow();
    expect(() => authorizeRequest({ path: null, method: 'GET' }, access('bookkeeper'))).toThrow();
  });
});

describe('sensitive field masking', () => {
  const body = {
    employees: [{ id: 'e1', ssn: '123-45-6789', payRate: '20.00' }],
    bank: { accountNumber: '000123456789', bankName: 'First' },
  };

  it('masks SSNs and account numbers without the flags', () => {
    const m = maskSensitive(body, access('bookkeeper'));
    expect(m.employees[0].ssn).toBe('***-**-6789');
    expect(m.bank.accountNumber).toBe('••••6789');
    expect(m.bank.bankName).toBe('First');
    expect(body.employees[0].ssn).toBe('123-45-6789'); // input untouched
  });

  it('shows full values with the flags', () => {
    const payroll = maskSensitive(body, access('payroll_processor'));
    expect(payroll.employees[0].ssn).toBe('123-45-6789');
    expect(payroll.bank.accountNumber).toBe('••••6789');
    expect(maskSensitive(body, access('admin'))).toBe(body);
  });

  it('leaves class instances (Date) intact', () => {
    const d = new Date('2026-01-01');
    const m = maskSensitive({ when: d, ssn: '111223333' }, access('sales'));
    expect(m.when).toBe(d);
    expect(m.ssn).toBe('***-**-3333');
  });
});
