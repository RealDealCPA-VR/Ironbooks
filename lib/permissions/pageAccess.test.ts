/**
 * prefsperms (PARITY K): the menus, command bar and buttons follow the activity rights.
 */
import { describe, expect, it } from 'vitest';
import { canSeePage, canUseActivity } from './pageAccess';
import { buttonRight, rightAllowed } from './buttonRights';
import { hideBalances, balanceText } from './balances';
import { unionRoles, type PermissionGrant } from './model';
import { visibleNavGroups } from '@/lib/nav';
import { canDoAction, COMMAND_ACTIONS } from '@/lib/commands/actions';

function mapFor(permissions: PermissionGrant) {
  const a = unionRoles([{ key: 'x', name: 'x', description: '', builtin: false, permissions, flags: {} }]);
  return { ...a.activities, ...a.permissions } as Record<string, string[]>;
}

describe('pages and menus by activity', () => {
  const invoicesOnly = mapFor({ 'customers.invoices': ['view', 'create'] });

  it('shows Invoices but not Receive Payments to an Invoices-only role', () => {
    expect(canSeePage('/invoices', invoicesOnly)).toBe(true);
    expect(canSeePage('/payments', invoicesOnly)).toBe(false);
    expect(canSeePage('/dashboard', invoicesOnly)).toBe(true); // open to every member
    const links = visibleNavGroups('advanced', invoicesOnly, new Set()).flatMap((g) => g.links.map((l) => l.path));
    expect(links).toContain('/invoices');
    expect(links).not.toContain('/payments');
    expect(links).not.toContain('/estimates');
  });

  it('falls back to areas for a map without activities (older servers)', () => {
    expect(canSeePage('/payments', { customers: ['view'] })).toBe(true);
    expect(canUseActivity({ customers: ['view'] }, 'customers.center', 'view_balance')).toBe(true);
    expect(canSeePage('/payments', null)).toBe(true);
  });

  it('command bar "Receive payment" needs Create on Receive Payments itself', () => {
    const receive = COMMAND_ACTIONS.find((a) => a.key === 'receive-payment')!;
    const invoice = COMMAND_ACTIONS.find((a) => a.key === 'new-invoice')!;
    expect(canDoAction(invoice.needs, invoicesOnly, invoice.href)).toBe(true);
    expect(canDoAction(receive.needs, invoicesOnly, receive.href)).toBe(false);
  });
});

describe('buttons a role cannot use', () => {
  it('reads New / Delete / Print / Email from the label', () => {
    expect(buttonRight('New invoice')).toBe('create');
    expect(buttonRight('+ New')).toBe('create');
    expect(buttonRight('Anything', 'new')).toBe('create');
    expect(buttonRight('Delete')).toBe('delete');
    expect(buttonRight('Print')).toBe('print');
    expect(buttonRight('Email invoice')).toBe('print');
    expect(buttonRight('Save & Close')).toBeNull();
    expect(buttonRight('Void')).toBeNull();
    expect(buttonRight('Newsletter settings')).toBeNull();
  });

  it('never greys out a right the page activity does not have (Admin keeps Print on Sales Tax Reports)', () => {
    const admin = mapFor({ sales_tax: ['full'], customers: ['full'] });
    // Sales Tax Reports has no Print right of its own: the print goes through another activity.
    expect(rightAllowed(['sales_tax.reports'], admin, 'print')).toBe(true);
    expect(rightAllowed(['sales_tax.reports'], mapFor({ 'sales_tax.reports': ['view'] }), 'print')).toBe(true);
    // Invoices does have Print: an Invoices role without it is greyed out, Admin is not.
    expect(rightAllowed(['customers.invoices'], admin, 'print')).toBe(true);
    expect(rightAllowed(['customers.invoices'], mapFor({ 'customers.invoices': ['view', 'create'] }), 'print')).toBe(false);
    // Several activities on one page: any one having the right is enough.
    expect(rightAllowed(['users.users', 'users.roles'], mapFor({ 'users.roles': ['view', 'delete'] }), 'delete')).toBe(true);
  });
});

describe('View Balance', () => {
  it('blanks balance fields deeply and marks the object', () => {
    const out = hideBalances({ accounts: [{ id: 'a', name: 'Checking', balance: '10.00', when: new Date(0) }], openingBalance: '5.00' });
    expect(out.accounts[0]).toMatchObject({ id: 'a', name: 'Checking', balance: null, balanceHidden: true });
    expect(out.accounts[0].when).toBeInstanceOf(Date);
    expect(out.openingBalance).toBeNull();
    expect(balanceText(null, String, true)).toBe('Hidden');
    expect(balanceText('1', (v) => `$${v}`)).toBe('$1');
  });
});
