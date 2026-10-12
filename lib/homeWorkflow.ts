/**
 * Data for the QuickBooks-style Home page workflow diagram (components/HomeWorkflow.tsx,
 * rendered at the top of app/dashboard/page.tsx).
 *
 * Each section is a set of flows; a flow is an ordered list of steps drawn left-to-right
 * with arrows between them (the order money actually moves through the books). Every href
 * must be a real page — lib/homeWorkflow.test.ts checks each one against app/.
 *
 * Also hosts the pure helper that builds the "Account Balances" panel from the chart of
 * accounts and trial-balance activity.
 */
import Decimal from 'decimal.js';
import { toAmountString } from '@/lib/money';

export type WorkflowIcon =
  | 'purchase-order' | 'receive-inventory' | 'enter-bills' | 'pay-bills'
  | 'estimates' | 'sales-orders' | 'invoices' | 'receive-payments' | 'deposits'
  | 'sales-receipts' | 'statements' | 'refunds'
  | 'time' | 'pay-employees' | 'pay-liabilities' | 'payroll-forms'
  | 'chart-of-accounts' | 'items' | 'reminders'
  | 'write-checks' | 'check-register' | 'reconcile' | 'bank-feeds' | 'transfers'
  | 'vendors' | 'customers' | 'employees';

export interface WorkflowStep {
  label: string;
  href: string;
  icon: WorkflowIcon;
  /** Plain-language tooltip / accessible description of what the step does. */
  hint: string;
}

export interface WorkflowSection {
  id: 'vendors' | 'customers' | 'employees' | 'company' | 'banking';
  title: string;
  /** "Center" link for the section heading (e.g. Vendor list). */
  centerHref: string;
  centerIcon: WorkflowIcon;
  /** Ordered flows (arrows drawn between consecutive steps). */
  flows: WorkflowStep[][];
  /** Stand-alone shortcuts shown under the flows (no arrows). */
  extras?: WorkflowStep[];
}

export const HOME_WORKFLOW: WorkflowSection[] = [
  {
    id: 'vendors',
    title: 'Vendors',
    centerHref: '/vendors',
    centerIcon: 'vendors',
    flows: [
      [
        { label: 'Purchase Orders', href: '/purchase-orders', icon: 'purchase-order', hint: 'Order goods from a vendor.' },
        { label: 'Receive Inventory', href: '/item-receipts', icon: 'receive-inventory', hint: 'Record items that arrived.' },
        { label: 'Enter Bills', href: '/bills', icon: 'enter-bills', hint: 'Record a bill you will pay later.' },
        { label: 'Pay Bills', href: '/pay-bills', icon: 'pay-bills', hint: 'Pay bills you have entered.' },
      ],
    ],
  },
  {
    id: 'customers',
    title: 'Customers',
    centerHref: '/customers',
    centerIcon: 'customers',
    flows: [
      [
        { label: 'Estimates', href: '/estimates', icon: 'estimates', hint: 'Quote a price before the work.' },
        { label: 'Sales Orders', href: '/sales-orders', icon: 'sales-orders', hint: 'Track an order you will fill later.' },
        { label: 'Create Invoices', href: '/invoices', icon: 'invoices', hint: 'Bill a customer who will pay later.' },
        { label: 'Receive Payments', href: '/payments', icon: 'receive-payments', hint: 'Record money a customer paid you.' },
        { label: 'Record Deposits', href: '/deposits', icon: 'deposits', hint: 'Group payments into a bank deposit.' },
      ],
    ],
    extras: [
      { label: 'Sales Receipts', href: '/sales-receipts', icon: 'sales-receipts', hint: 'A sale paid on the spot.' },
      { label: 'Statements', href: '/reports/statements', icon: 'statements', hint: 'Send customers a summary of what they owe.' },
      { label: 'Refunds & Credits', href: '/credit-memos', icon: 'refunds', hint: 'Give a customer a credit or refund.' },
    ],
  },
  {
    id: 'employees',
    title: 'Employees',
    centerHref: '/employees',
    centerIcon: 'employees',
    flows: [
      [
        { label: 'Enter Time', href: '/time-tracking', icon: 'time', hint: 'Record hours worked.' },
        { label: 'Pay Employees', href: '/pay-runs', icon: 'pay-employees', hint: 'Run payroll and create paychecks.' },
        { label: 'Pay Liabilities', href: '/pay-liabilities', icon: 'pay-liabilities', hint: 'Send withheld payroll taxes to the government.' },
        { label: 'Payroll Forms', href: '/payroll-forms', icon: 'payroll-forms', hint: 'Prepare W-2s, 941s and other forms.' },
      ],
    ],
  },
  {
    id: 'company',
    title: 'Company',
    centerHref: '/settings',
    centerIcon: 'chart-of-accounts',
    flows: [],
    extras: [
      { label: 'Chart of Accounts', href: '/accounts', icon: 'chart-of-accounts', hint: 'The categories your money is sorted into.' },
      { label: 'Items & Services', href: '/items', icon: 'items', hint: 'Things you buy and sell.' },
      // Same-page anchor: the Reminders card further down the dashboard.
      { label: 'Reminders', href: '#reminders', icon: 'reminders', hint: 'Bills due, low stock and reconciliation status.' },
    ],
  },
  {
    id: 'banking',
    title: 'Banking',
    centerHref: '/banking',
    centerIcon: 'check-register',
    flows: [],
    extras: [
      { label: 'Write Checks', href: '/expenses', icon: 'write-checks', hint: 'Pay for something right away.' },
      { label: 'Check Register', href: '/registers', icon: 'check-register', hint: 'See every transaction in an account.' },
      { label: 'Reconcile', href: '/reconcile', icon: 'reconcile', hint: 'Match your books to the bank statement.' },
      { label: 'Bank Feeds', href: '/bank-feeds', icon: 'bank-feeds', hint: 'Download transactions from your bank.' },
      { label: 'Transfer Funds', href: '/transfers', icon: 'transfers', hint: 'Move money between your accounts.' },
    ],
  },
];

/** Every step/center href in the diagram (for route-existence tests). */
export function allWorkflowHrefs(sections: WorkflowSection[] = HOME_WORKFLOW): string[] {
  const out: string[] = [];
  for (const s of sections) {
    out.push(s.centerHref);
    for (const f of s.flows) for (const step of f) out.push(step.href);
    for (const step of s.extras ?? []) out.push(step.href);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Account balances panel
// ---------------------------------------------------------------------------

export interface BalanceAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  isActive?: boolean;
}

export interface BalanceActivity {
  accountId: string;
  debit: string;
  credit: string;
}

export interface AccountBalanceRow {
  id: string;
  code: string;
  name: string;
  /** 'bank' | 'credit_card' | 'undeposited' — drives the label + link. */
  kind: 'bank' | 'credit_card' | 'undeposited';
  /** Natural-sign balance: money you have for banks, money you owe for cards. */
  balance: string;
}

/** Subtypes shown on the Home page balances panel (QB "Account Balances"). */
const PANEL_SUBTYPES = new Set(['checking', 'savings', 'undeposited_funds', 'credit_card']);

/**
 * Build the balances panel rows. Banks (checking/savings) are debit-normal (debits - credits);
 * credit cards are credit-normal (credits - debits, i.e. what you owe). Undeposited Funds has its
 * own subtype (an Other Current Asset); legacy charts that still hold it as a bank account are
 * recognised by name.
 */
export function buildAccountBalances(
  accounts: BalanceAccount[],
  activity: BalanceActivity[],
): AccountBalanceRow[] {
  const byId = new Map(activity.map((a) => [a.accountId, a]));
  const rows: AccountBalanceRow[] = [];
  for (const a of accounts) {
    if (a.isActive === false || !PANEL_SUBTYPES.has(a.subtype)) continue;
    const act = byId.get(a.id);
    const debit = new Decimal(act?.debit || 0);
    const credit = new Decimal(act?.credit || 0);
    const isCard = a.subtype === 'credit_card';
    const kind: AccountBalanceRow['kind'] = isCard
      ? 'credit_card'
      : a.subtype === 'undeposited_funds' || /undeposited/i.test(a.name)
        ? 'undeposited'
        : 'bank';
    rows.push({
      id: a.id,
      code: a.code,
      name: a.name,
      kind,
      balance: toAmountString(isCard ? credit.minus(debit) : debit.minus(credit)),
    });
  }
  const order = { bank: 0, undeposited: 1, credit_card: 2 } as const;
  return rows.sort((x, y) => order[x.kind] - order[y.kind] || x.code.localeCompare(y.code));
}
