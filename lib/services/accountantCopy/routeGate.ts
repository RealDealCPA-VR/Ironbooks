/**
 * Accountant's Copy route gate (PARITY I1), called by getServerContext for every API request.
 *
 * In the ACCOUNTANT's working copy only the saves the changes file (.ibcx) can carry back to the
 * client are allowed: General Journal entries, checks / expenses, chart of accounts and classes —
 * plus housekeeping that never changes the books (signing in/out, your own preferences, saved
 * reports, notes, to-dos, backups, the Accountant's Copy screens themselves). Any other save is
 * refused BEFORE it runs, with a plain message, so nothing is done in the copy that would be
 * silently lost. Reads (GET) are never restricted. The dividing date itself is enforced in the
 * services (guard.ts, via assertPeriodOpen).
 */
import type { DB } from '@/lib/db';
import { currentRequestInfo } from '@/lib/permissions/enforce';
import { ServiceError } from '../errors';
import { activeCopy } from './guard';

/** API prefixes an accountant may save to in an Accountant's Copy. */
export const ACCOUNTANT_COPY_ALLOWED_API = [
  '/api/journal-entries',
  '/api/expenses',
  '/api/accounts',
  '/api/classes',
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
];

export function accountantCopyAllowsApi(path: string): boolean {
  return ACCOUNTANT_COPY_ALLOWED_API.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Refuse a save the accountant's copy can't send back (no-op outside a request / for reads). */
export async function enforceAccountantCopyGate(db: DB, companyId: string): Promise<void> {
  const info = await currentRequestInfo();
  if (!info?.path || info.method === 'GET' || info.method === 'HEAD') return;
  if (!info.path.startsWith('/api/') || accountantCopyAllowsApi(info.path)) return;
  const copy = await activeCopy(db, companyId);
  if (!copy || copy.side !== 'accountant') return;
  throw new ServiceError(
    'FORBIDDEN',
    "That isn't available in an Accountant's Copy because it can't be sent back to your client. " +
      'In this copy you can make journal entries, write or edit checks and expenses, and add or edit accounts and classes. ' +
      'Note anything else for your client in the changes file.',
    { accountantCopy: true },
  );
}
