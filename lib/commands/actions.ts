/**
 * Command bar quick actions ("new invoice", "pay bills", "reconcile", "record deposit"…) with
 * the permission each one needs, plus the permission filter shared by every result source.
 * Results only include pages/actions the user may use — the same rule as the sidebar
 * (lib/nav.ts filterNavGroups): a page needs 'view' of its PAGE_AREAS area; an action that
 * creates something also needs 'create'. COSMETIC like the sidebar — every API route is still
 * enforced server-side. PURE (client + server).
 */
import { pageAreasFor } from '@/lib/permissions/routes';
import type { Action, Area } from '@/lib/permissions/model';
import type { ActionKey } from './intent';
import type { PrefillKind } from './prefill';

export type PermissionMap = Partial<Record<Area, readonly string[]>> | null | undefined;

export interface CommandAction {
  key: string;
  label: string;
  href: string;
  /** Plain-language explanation (shown under the label). */
  description: string;
  keywords: string;
  /** Permission needed beyond 'view' of the page (e.g. creating a document). */
  needs?: { area: Area; action: Action };
  /** Open the page's blank NEW form through the prefill handoff (pages without ?new=1). */
  prefillKind?: PrefillKind;
}

export const COMMAND_ACTIONS: CommandAction[] = [
  { key: 'new-invoice', label: 'New invoice', href: '/invoices?new=1', description: 'Bill a customer now, get paid later.', keywords: 'create invoice bill customer charge', needs: { area: 'customers', action: 'create' } },
  { key: 'new-sales-receipt', label: 'New sales receipt', href: '/sales-receipts', description: 'Record a sale you were paid for on the spot.', keywords: 'cash sale paid now receipt sold', needs: { area: 'customers', action: 'create' }, prefillKind: 'sales_receipt' },
  { key: 'new-estimate', label: 'New estimate', href: '/estimates', description: 'Send a customer a quote.', keywords: 'quote bid proposal estimate', needs: { area: 'customers', action: 'create' }, prefillKind: 'estimate' },
  { key: 'receive-payment', label: 'Receive payment', href: '/payments?new=1', description: 'A customer paid an invoice.', keywords: 'customer payment got paid collect receive', needs: { area: 'customers', action: 'create' } },
  { key: 'enter-bill', label: 'Enter a bill', href: '/bills', description: 'Record a vendor bill to pay later.', keywords: 'new bill vendor invoice owe enter', needs: { area: 'vendors', action: 'create' }, prefillKind: 'bill' },
  { key: 'pay-bills', label: 'Pay bills', href: '/pay-bills', description: 'Pay the vendor bills you already entered.', keywords: 'pay bills vendors suppliers', needs: { area: 'vendors', action: 'create' } },
  { key: 'write-check', label: 'Write a check / record an expense', href: '/expenses?new=1', description: 'You paid for something right away.', keywords: 'new check cheque expense spend debit card purchase', needs: { area: 'banking', action: 'create' } },
  { key: 'record-deposit', label: 'Record a deposit', href: '/deposits?new=1', description: 'Take payments you received to the bank.', keywords: 'make deposit bank undeposited funds', needs: { area: 'banking', action: 'create' } },
  { key: 'reconcile', label: 'Reconcile an account', href: '/reconcile', description: 'Match your books to a bank or card statement.', keywords: 'reconcile checking bank statement balance', needs: { area: 'accounting', action: 'create' } },
  { key: 'transfer', label: 'Transfer money', href: '/transfers', description: 'Move money between your own accounts.', keywords: 'transfer funds move money savings', needs: { area: 'accounting', action: 'create' } },
  { key: 'journal-entry', label: 'New journal entry', href: '/journal?new=1', description: 'Adjust the books directly (accountants).', keywords: 'general journal adjust gl entry', needs: { area: 'accounting', action: 'create' } },
  { key: 'run-payroll', label: 'Run payroll', href: '/pay-runs', description: 'Pay your employees.', keywords: 'pay run paycheck payroll employees', needs: { area: 'payroll', action: 'create' } },
  { key: 'bank-feeds', label: 'Import bank transactions', href: '/bank-feeds', description: 'Import a statement file from your bank.', keywords: 'bank feeds import download ofx qfx csv', needs: { area: 'banking', action: 'create' } },
  { key: 'unpaid-bills', label: 'Unpaid bills', href: '/reports/std/unpaid-bills-detail', description: 'Bills you still owe, by vendor.', keywords: 'unpaid open bills owe ap aging' },
  { key: 'unpaid-invoices', label: 'Unpaid invoices', href: '/reports/std/open-invoices', description: 'Invoices customers still owe you.', keywords: 'unpaid open invoices owed ar aging who owes' },
];

/** The page an action/intent result opens, for the plain-language action keys. */
export const ACTION_HREFS: Record<ActionKey, string> = {
  pay_bills: '/pay-bills',
  reconcile: '/reconcile',
  record_deposit: '/deposits?new=1',
  receive_payment: '/payments?new=1',
  transfer_funds: '/transfers',
  journal_entry: '/journal?new=1',
  run_payroll: '/pay-runs',
  bank_feeds: '/bank-feeds',
};

/** The permission each plain-language action needs. */
export const ACTION_NEEDS: Record<ActionKey, { area: Area; action: Action }> = {
  pay_bills: { area: 'vendors', action: 'create' },
  reconcile: { area: 'accounting', action: 'create' },
  record_deposit: { area: 'banking', action: 'create' },
  receive_payment: { area: 'customers', action: 'create' },
  transfer_funds: { area: 'accounting', action: 'create' },
  journal_entry: { area: 'accounting', action: 'create' },
  run_payroll: { area: 'payroll', action: 'create' },
  bank_feeds: { area: 'banking', action: 'create' },
};

function basePath(href: string): string {
  return href.split('?')[0].split('#')[0];
}

/** May this person open the page behind `href`? (null permissions = not loaded → allowed). */
export function canOpenHref(href: string, permissions: PermissionMap): boolean {
  if (!permissions) return true;
  const areas = pageAreasFor(basePath(href));
  return !areas || areas.some((a) => permissions[a]?.includes('view') ?? false);
}

export function canDoAction(needs: { area: Area; action: Action } | undefined, permissions: PermissionMap): boolean {
  if (!needs || !permissions) return true;
  return permissions[needs.area]?.includes(needs.action) ?? false;
}

/** Actions this person may use, minus pages switched off in Preferences. */
export function visibleActions(permissions: PermissionMap, hiddenPaths?: ReadonlySet<string>): CommandAction[] {
  return COMMAND_ACTIONS.filter(
    (a) => !hiddenPaths?.has(basePath(a.href)) && canOpenHref(a.href, permissions) && canDoAction(a.needs, permissions),
  );
}

/** Case-insensitive match on label + keywords (every typed word must appear). Empty → all. */
export function filterActions(query: string, permissions: PermissionMap, hiddenPaths?: ReadonlySet<string>, limit = 6): CommandAction[] {
  const list = visibleActions(permissions, hiddenPaths);
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const qWords = q.split(/\s+/).filter((w) => w.length > 1 || /\d/.test(w));
  return list
    .map((a, order) => {
      const hay = `${a.label} ${a.keywords}`.toLowerCase();
      const label = a.label.toLowerCase();
      const score = label.startsWith(q) ? 3 : label.includes(q) ? 2 : qWords.length && qWords.every((w) => hay.includes(w)) ? 1 : 0;
      return { a, order, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.order - y.order)
    .slice(0, limit)
    .map((x) => x.a);
}
