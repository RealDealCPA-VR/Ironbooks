/**
 * Accountant's Copy restrictions (QB "Accountant's Copy" / dividing date, PARITY I1).
 *
 * While a company has an Accountant's Copy:
 *  - CLIENT file (side 'client', status 'outstanding'):
 *      - transactions dated ON OR BEFORE the dividing date can't be added, changed or voided
 *        (assertDividingDateOpen, called by assertPeriodOpen — the same choke point every posting,
 *        void and posted edit already goes through for the closing date);
 *      - list entries can't be deleted (made inactive) or merged, and accounts used on or before
 *        the dividing date can't be edited (assertListDeleteAllowed / assertAccountEditAllowed);
 *      - work AFTER the dividing date carries on as usual.
 *  - ACCOUNTANT file (side 'accountant'): the opposite date rule — only transactions dated ON OR
 *    BEFORE the dividing date — and only the kinds of change the changes file (.ibcx) can carry
 *    back: General Journal entries, checks / expenses, chart-of-accounts edits and new accounts
 *    and classes. Other saves are refused before they run by the route gate (routeGate.ts).
 *
 * The closing-date password never bypasses the dividing date. The only bypass is the client's
 * own import of the accountant's changes (runAccountantImport), which re-applies them through the
 * normal services — every other guard (closing date, reconciliation, record locking, ledger
 * balance) stays on.
 *
 * Dependency-light on purpose: imported by _base.ts (writeAudit backstop) and fiscalPeriods.ts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { accountantCopies, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { ServiceError } from '../errors';
import type { ServiceContext } from '../_base';

export type CopySide = 'client' | 'accountant';

export interface ActiveCopy {
  id: string;
  side: CopySide;
  status: string;
  dividingDate: string;
}

/** Plain-language date, e.g. "Mar 31, 2026" (UTC — dividing dates are calendar dates). */
export function formatDividingDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The restriction in force for a company, or null. Client: the outstanding copy. Accountant: the
 * file IS an Accountant's Copy (always restricted, before and after exporting changes).
 */
export async function activeCopy(db: DB, companyId: string): Promise<ActiveCopy | null> {
  const [row] = await db
    .select({
      id: accountantCopies.id,
      side: accountantCopies.side,
      status: accountantCopies.status,
      dividingDate: accountantCopies.dividingDate,
    })
    .from(accountantCopies)
    .where(
      and(
        eq(accountantCopies.companyId, companyId),
        or(
          and(eq(accountantCopies.side, 'client'), eq(accountantCopies.status, 'outstanding')),
          eq(accountantCopies.side, 'accountant'),
        ),
      ),
    )
    .orderBy(desc(accountantCopies.createdAt))
    .limit(1);
  return row ? { ...row, side: row.side as CopySide } : null;
}

// ---------------------------------------------------------------------------
// Import bypass (client applying the accountant's changes)
// ---------------------------------------------------------------------------

const importScope = new AsyncLocalStorage<{ copyId: string }>();

/**
 * Run `fn` as the import of the accountant's changes for copy `copyId`: the dividing-date and
 * list restrictions of THAT copy are lifted inside `fn` only. Everything else still applies.
 */
export function runAccountantImport<T>(copyId: string, fn: () => Promise<T>): Promise<T> {
  return importScope.run({ copyId }, fn);
}

function importing(copy: ActiveCopy): boolean {
  return importScope.getStore()?.copyId === copy.id;
}

// ---------------------------------------------------------------------------
// Dividing date
// ---------------------------------------------------------------------------

/** Ledger sources an accountant may post in an Accountant's Copy (what the changes file carries). */
export function accountantMayPost(sourceRef: string | null): boolean {
  if (sourceRef === null || sourceRef === 'manual') return true;
  return sourceRef.startsWith('reversal:') || sourceRef.startsWith('expense:');
}

export function dividingDateError(copy: ActiveCopy): ServiceError {
  const when = formatDividingDate(copy.dividingDate);
  return copy.side === 'client'
    ? new ServiceError(
        'CONFLICT',
        `Your accountant is working on transactions dated on or before ${when} (Accountant's Copy). ` +
          `Those can't be added, changed or voided here until you import your accountant's changes or cancel the Accountant's Copy. ` +
          `Transactions dated after ${when} are fine.`,
        { accountantCopy: true, side: copy.side, dividingDate: copy.dividingDate },
      )
    : new ServiceError(
        'CONFLICT',
        `This is an Accountant's Copy with a dividing date of ${when}. You can only work on transactions dated on or before ${when}; ` +
          `your client keeps entering everything after it.`,
        { accountantCopy: true, side: copy.side, dividingDate: copy.dividingDate },
      );
}

/**
 * Refuse a posting / void / edit dated `date` that the Accountant's Copy does not allow.
 * `sourceRef` (when the caller knows it) names the ledger source: on the accountant side only
 * General Journal entries, reversals and checks / expenses may post (they travel back to the client).
 */
export async function assertDividingDateOpen(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  date: Date,
  opts: { sourceRef?: string | null } = {},
): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || importing(copy)) return;
  const day = new Date(date).toISOString().slice(0, 10);
  if (copy.side === 'client') {
    if (day <= copy.dividingDate) throw dividingDateError(copy);
    return;
  }
  if (day > copy.dividingDate) throw dividingDateError(copy);
  if (opts.sourceRef !== undefined && !accountantMayPost(opts.sourceRef)) {
    throw new ServiceError(
      'FORBIDDEN',
      "This kind of transaction can't be entered in an Accountant's Copy because it can't be sent back to your client. " +
        'You can make journal entries, write or edit checks and expenses, and add or edit accounts and classes.',
      { accountantCopy: true, side: copy.side, sourceRef: opts.sourceRef },
    );
  }
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Audit entity types that are list entries (deleting / merging them is restricted). */
export const LIST_ENTITY_TYPES = new Set([
  'account', 'customer', 'vendor', 'item', 'employee', 'other_name', 'job', 'class', 'location',
  'sales_rep', 'payment_terms', 'payment_method', 'ship_via', 'customer_type', 'vendor_type',
  'job_type', 'customer_message', 'price_level', 'billing_rate_level', 'sales_tax_code', 'tax_rate',
  'tax_agency', 'payroll_item', 'inventory_site', 'uom_set', 'workers_comp_code', 'vehicle',
  'currency', 'fixed_asset',
]);

/**
 * QB: while an Accountant's Copy exists, list entries can't be deleted or merged (in this app,
 * deleting a list entry makes it inactive). Applies to the client and in the accountant's copy
 * (where it could not be sent back).
 */
export async function assertListDeleteAllowed(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  op: 'delete' | 'merge',
  what = 'list entries',
): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || importing(copy)) return;
  const verb = op === 'merge' ? 'merged' : 'deleted or made inactive';
  throw new ServiceError(
    'CONFLICT',
    copy.side === 'client'
      ? `An Accountant's Copy of this company is out with your accountant, so ${what} can't be ${verb} until you import their changes or cancel the Accountant's Copy. You can still add new ones.`
      : `In an Accountant's Copy, ${what} can't be ${verb} (the change can't be sent back to your client). Ask your client to do it in their file.`,
    { accountantCopy: true, side: copy.side },
  );
}

/**
 * Client side: an account used by a transaction dated on or before the dividing date can't be
 * edited (name, type, parent, inactive) while the copy is outstanding — the accountant is working
 * with it. New accounts and accounts only used after the dividing date can be edited.
 */
export async function assertAccountEditAllowed(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  accountId: string,
): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || copy.side !== 'client' || importing(copy)) return;
  const after = new Date(`${copy.dividingDate}T00:00:00.000Z`);
  after.setUTCDate(after.getUTCDate() + 1);
  const [used] = await ctx.db
    .select({ id: journalEntryLines.id })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntryLines.accountId, accountId),
        eq(journalEntries.companyId, ctx.companyId),
        inArray(journalEntries.status, ['posted', 'void']),
        lt(journalEntries.date, after),
      ),
    )
    .limit(1);
  if (used) {
    const when = formatDividingDate(copy.dividingDate);
    throw new ServiceError(
      'CONFLICT',
      `This account has transactions dated on or before ${when}, and your accountant is working on that period (Accountant's Copy). ` +
        `It can't be changed until you import your accountant's changes or cancel the Accountant's Copy.`,
      { accountantCopy: true, side: copy.side, dividingDate: copy.dividingDate },
    );
  }
}

/**
 * writeAudit backstop: a list-entry DELETE recorded while an Accountant's Copy restriction is in
 * force is refused (the enclosing transaction rolls back). The services that delete list entries
 * also check up front (assertListDeleteAllowed); this catches any path that only audits.
 */
export async function auditBackstop(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  params: { action: string; entityType: string },
): Promise<void> {
  if (params.action !== 'delete' || !LIST_ENTITY_TYPES.has(params.entityType)) return;
  await assertListDeleteAllowed(ctx, 'delete', 'list entries');
}

/**
 * updateAccount hook. Client side: making an account inactive counts as deleting it, and an
 * account used on or before the dividing date can't be edited. Accountant side: account edits
 * are allowed (they travel back in the changes file).
 */
export async function assertAccountChangeAllowed(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  accountId: string,
  opts: { deactivate: boolean },
): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || copy.side !== 'client' || importing(copy)) return;
  if (opts.deactivate) await assertListDeleteAllowed(ctx, 'delete', 'accounts');
  await assertAccountEditAllowed(ctx, accountId);
}
