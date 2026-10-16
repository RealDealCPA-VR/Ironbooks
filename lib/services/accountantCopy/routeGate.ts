/**
 * Accountant's Copy route gate (PARITY I1), called by getServerContext for every API request.
 *
 * In the ACCOUNTANT's working copy only the saves the changes file (.ibcx) can carry back to the
 * client are allowed: General Journal entries, checks / expenses / credit card charges, transfers,
 * deposits, invoices, sales receipts, credit memos, received payments, bills, bill payments,
 * vendor credits, item receipts, inventory quantity adjustments, estimates, sales orders, purchase
 * orders, credits and General Journal lines applied, bank reconciliations, the chart of accounts,
 * classes, customers, vendors, items and other names —
 * plus housekeeping that never changes the books (signing in/out, your own preferences, saved
 * reports, notes, to-dos, backups, the Accountant's Copy screens themselves). Any other save is
 * refused BEFORE it runs, with a plain message, so nothing is done in the copy that would be
 * silently lost. Reads (GET) are never restricted. The dividing date itself, conversions,
 * refunds, structural list edits and records dated after the dividing date are enforced in the
 * services (guard.ts).
 */
import type { DB } from '@/lib/db';
import { currentRequestInfo } from '@/lib/permissions/enforce';
import { ServiceError } from '../errors';
import { activeCopy } from './guard';

/** API prefixes an accountant may save to in an Accountant's Copy. */
export const ACCOUNTANT_COPY_ALLOWED_API = [
  '/api/journal-entries',
  '/api/expenses',
  '/api/transfers',
  '/api/deposits',
  '/api/accounts',
  '/api/classes',
  // Sales and purchases (format 3 of the changes file).
  '/api/invoices',
  '/api/sales-receipts',
  '/api/credit-memos',
  '/api/payments', // incl. /api/payments/journal-items (General Journal A/R lines applied)
  '/api/bills',
  '/api/bill-payments', // incl. /api/bill-payments/journal-items
  '/api/vendor-credits',
  '/api/item-receipts',
  '/api/estimates',
  '/api/sales-orders',
  '/api/purchase-orders',
  '/api/reconciliations',
  // Names and items (adding them, and editing their everyday fields — guard.ts refuses the rest).
  '/api/customers',
  '/api/vendors',
  '/api/items',
  '/api/lists/other-names',
  // Housekeeping.
  '/api/accountant-copy',
  '/api/accountant/working-trial-balance',
  '/api/accountant/list-changes',
  '/api/auth',
  '/api/sessions',
  '/api/unlock',
  '/api/preferences/my',
  '/api/memorized-reports',
  '/api/report-builder',
  '/api/report-schedules',
  '/api/reports',
  '/api/todos',
  '/api/notes',
  '/api/search',
  '/api/find',
  '/api/export',
  '/api/backup',
  '/api/portable',
  // Housekeeping added by features merged alongside the Accountant's Copy:
  '/api/backups', // Back Up & Restore page (settings, "Back up now", restore)
  '/api/attention/state', // your own snooze / dismiss of a "Needs attention" item
  '/api/attention/backup', // "Back up now" from the inbox
  '/api/sandbox', // Try it on a copy — entering, and above all LEAVING, must never be refused
  // Undo tokens never change the books; performing an undo is checked against the gate for the
  // inverse action's route (assertAccountantCopyAllowsPath in lib/services/undo.ts).
  '/api/undo',
  // Ctrl+K command bar: a read-only parse (POST only to carry the typed text); forms it opens
  // save through their own routes, which this gate checks as usual.
  '/api/command-bar',
];

/** Paths allowed only exactly (not their sub-paths). */
export const ACCOUNTANT_COPY_ALLOWED_EXACT = [
  // Adjust Quantity on Hand (action 'adjust' / 'cogs'): carried as an inventory adjustment. Physical
  // counts, value adjustments and batch counts (its sub-paths) are not.
  '/api/inventory',
];

/**
 * Sub-paths of allowed prefixes that are still refused: they change several records at once
 * outside the forms the changes file carries, or post something it can't (retainage release,
 * paying a credit card from a reconciliation, bulk list edits, estimate expiry sweeps).
 */
export const ACCOUNTANT_COPY_DENIED_API: RegExp[] = [
  /^\/api\/invoices\/retainage(\/|$)/,
  /^\/api\/estimates\/expire(\/|$)/,
  /^\/api\/reconciliations\/[^/]+\/pay(\/|$)/,
  /^\/api\/(customers|vendors|items)\/bulk(\/|$)/,
  /^\/api\/items\/change-prices(\/|$)/,
];

export function accountantCopyAllowsApi(path: string): boolean {
  if (ACCOUNTANT_COPY_DENIED_API.some((re) => re.test(path))) return false;
  if (ACCOUNTANT_COPY_ALLOWED_EXACT.includes(path)) return true;
  return ACCOUNTANT_COPY_ALLOWED_API.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Refuse a save the accountant's copy can't send back (no-op outside a request / for reads). */
export async function enforceAccountantCopyGate(db: DB, companyId: string): Promise<void> {
  const info = await currentRequestInfo();
  if (!info?.path || info.method === 'GET' || info.method === 'HEAD') return;
  await assertAccountantCopyAllowsPath(db, companyId, info.path);
}

/**
 * The gate for one API save path, also used for a save made on the user's behalf by another
 * route (Undo applies the inverse of a change through the services: /api/undo itself is allowed,
 * the inverse's own route must be too).
 */
export async function assertAccountantCopyAllowsPath(db: DB, companyId: string, path: string): Promise<void> {
  if (!path.startsWith('/api/') || accountantCopyAllowsApi(path)) return;
  const copy = await activeCopy(db, companyId);
  if (!copy || copy.side !== 'accountant') return;
  throw new ServiceError(
    'FORBIDDEN',
    "That isn't available in an Accountant's Copy because it can't be sent back to your client. " +
      'In this copy you can enter and fix journal entries, checks, expenses and credit card charges, transfers, deposits, invoices, ' +
      'sales receipts, credit memos, payments, bills, bill payments, vendor credits, item receipts, inventory adjustments, estimates, ' +
      'sales and purchase orders, apply credits, reconcile, and add or edit accounts, classes, customers, vendors, items and other names. ' +
      'Note anything else for your client in the changes file.',
    { accountantCopy: true },
  );
}
