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
 *    back: General Journal entries, checks / expenses / credit card charges, transfers, deposits,
 *    invoices, sales receipts, credit memos, received payments, bills, bill payments, vendor
 *    credits, item receipts, inventory adjustments, estimates / sales orders / purchase orders,
 *    credit and journal applications, bank reconciliations, chart-of-accounts edits, new classes
 *    and new / edited customers, vendors, items and other names. Other saves are refused before
 *    they run by the route gate (routeGate.ts) or here (conversions, refunds, bounced checks,
 *    structural list edits, anything touching a record dated after the dividing date).
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

/**
 * Ledger sources an accountant may post in an Accountant's Copy (what the changes file carries):
 * General Journal entries and reversals, transfers (which post without a source), checks /
 * expenses, deposits, sales forms and their COGS, received payments (posted as customer:<id> /
 * payment:<id>), bills, bill payments (vendor:<id>), vendor credits, item receipts, inventory
 * adjustments (item:<id>) and a reconciliation's service charge / interest. Refunds, bounced
 * checks, paychecks, loans, fixed assets, condense, imports … are not carried back.
 */
const ACCOUNTANT_SOURCES = [
  'reversal:',
  'expense:',
  'deposit:',
  'invoice:',
  'invoice-cogs:',
  'salesreceipt:',
  'credit_memo:',
  'creditmemo-cogs:',
  'customer:',
  'payment:',
  'bill:',
  'vendor:',
  'vendor_credit:',
  'item_receipt:',
  'item_receipt_edit:',
  'item_receipt_void:',
  'item_receipt_claim',
  'item:',
  'reconciliation:',
];

export function accountantMayPost(sourceRef: string | null): boolean {
  if (sourceRef === null || sourceRef === 'manual') return true;
  return ACCOUNTANT_SOURCES.some((p) => sourceRef.startsWith(p));
}

/** What an accountant can do in the copy (used in refusals). */
export const ACCOUNTANT_CAN =
  "In an Accountant's Copy you can enter and fix journal entries, checks, expenses and credit card charges, transfers, deposits, " +
  'invoices, sales receipts, credit memos, received payments, bills, bill payments, vendor credits, item receipts, inventory adjustments, ' +
  'estimates, sales orders and purchase orders, apply credits, reconcile, and add or edit accounts, classes, customers, vendors, items and other names.';

/**
 * Accountant side: a conversion (estimate / sales order → invoice, purchase order / item receipt
 * → bill) links two forms in a way the changes file can't rebuild on the client's side — refused
 * in the copy; enter the invoice or bill directly.
 */
export async function assertAccountantMayConvert(ctx: Pick<ServiceContext, 'db' | 'companyId'>, what: string): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || copy.side !== 'accountant') return;
  throw new ServiceError(
    'FORBIDDEN',
    `${what} can't be done in an Accountant's Copy (the link between the two forms can't be sent back to your client). Enter the invoice or bill directly instead.`,
    { accountantCopy: true, side: copy.side },
  );
}

/**
 * Accountant side: voiding a journal entry from the journal screens. Only General Journal entries
 * (and reversals) travel back that way; an entry a form or an inventory adjustment posted is
 * voided with its form. An inventory quantity adjustment has no void in this app at all (its
 * quantity and site movements would stay), so its entry can't be voided in the copy — enter a new
 * adjustment that puts the quantity back instead (that one travels).
 */
export async function assertAccountantMayVoidEntry(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  sourceRef: string | null,
): Promise<void> {
  if (sourceRef === null || sourceRef === 'manual' || sourceRef.startsWith('reversal:')) return;
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || copy.side !== 'accountant') return;
  const adjustment = sourceRef.startsWith('item:');
  throw new ServiceError(
    'FORBIDDEN',
    adjustment
      ? "An inventory adjustment can't be voided or changed in an Accountant's Copy (the void can't be sent back to your client). Enter a new inventory adjustment that corrects the quantity instead."
      : "This entry was posted by a form, so it can't be voided here in an Accountant's Copy. Open the form and void it there (that change is sent back to your client).",
    { accountantCopy: true, side: copy.side },
  );
}

/**
 * Accountant side: billing time and costs (bill / check lines and time entries marked billable)
 * onto an invoice stamps those source records as billed. The changes file carries the invoice
 * but not those links, so the client could bill the same costs again — refused in the copy; enter
 * the invoice lines directly and let the client bill the costs, or mark them billed after import.
 */
export async function assertAccountantMayBillCosts(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || copy.side !== 'accountant') return;
  throw new ServiceError(
    'FORBIDDEN',
    "Billable time and costs can't be added to an invoice in an Accountant's Copy (your client's file would still show those costs as unbilled, so they could be billed twice). Enter the invoice lines directly instead.",
    { accountantCopy: true, side: copy.side },
  );
}

/**
 * Accountant side: changing a record dated after the dividing date (applying a credit or payment
 * to an invoice / bill the client entered after it) is refused — that record belongs to the client.
 */
export async function assertAccountantDatesOpen(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  dates: Array<Date | string | null | undefined>,
  what: string,
): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || copy.side !== 'accountant' || importing(copy)) return;
  for (const d of dates) {
    if (!d) continue;
    const day = new Date(d).toISOString().slice(0, 10);
    if (day > copy.dividingDate) {
      const when = formatDividingDate(copy.dividingDate);
      throw new ServiceError(
        'CONFLICT',
        `${what} is dated after the dividing date (${when}), so it belongs to your client and can't be changed in this Accountant's Copy.`,
        { accountantCopy: true, side: copy.side, dividingDate: copy.dividingDate },
      );
    }
  }
}

/**
 * Bank reconciliations: in the client's file a statement dated on or before the dividing date
 * can't be reconciled or un-reconciled while the copy is out; in the accountant's copy only those
 * statements can.
 */
export async function assertReconciliationDateOpen(ctx: Pick<ServiceContext, 'db' | 'companyId'>, statementDate: Date): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || importing(copy)) return;
  const day = new Date(statementDate).toISOString().slice(0, 10);
  const when = formatDividingDate(copy.dividingDate);
  if (copy.side === 'client' && day <= copy.dividingDate) {
    throw new ServiceError(
      'CONFLICT',
      `Your accountant is working on statements dated on or before ${when} (Accountant's Copy), so this statement can't be reconciled or un-reconciled here until you import their changes or cancel the copy.`,
      { accountantCopy: true, side: copy.side, dividingDate: copy.dividingDate },
    );
  }
  if (copy.side === 'accountant' && day > copy.dividingDate) {
    throw new ServiceError(
      'CONFLICT',
      `In this Accountant's Copy you can only reconcile statements dated on or before ${when}; your client reconciles the later ones.`,
      { accountantCopy: true, side: copy.side, dividingDate: copy.dividingDate },
    );
  }
}

const NUM_RE = /^-?\d+(\.\d+)?$/;
const same = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown) => (v === undefined || v === null || v === '' ? null : typeof v === 'number' ? String(v) : v);
  const x = norm(a);
  const y = norm(b);
  if (x === null || y === null) return x === y;
  if (typeof x === 'string' && typeof y === 'string' && NUM_RE.test(x) && NUM_RE.test(y)) return Number(x) === Number(y);
  return JSON.stringify(x) === JSON.stringify(y);
};

/** Structural fields of list records (QB: hierarchy, active status, item type / accounts / tracking, vendor currency). */
const STRUCTURAL: Record<string, Array<[string, string]>> = {
  customer: [
    ['parentId', 'its place in the customer list (sub-customer of)'],
    ['isActive', 'whether it is active'],
    ['priceLevelId', 'its price level'],
    ['shipToAddresses', 'its list of ship-to addresses'],
  ],
  vendor: [
    ['isActive', 'whether it is active'],
    ['currency', 'its currency'],
    ['taxId', 'its tax ID'],
    ['vendorTypeId', 'its vendor type'],
    ['billingRateLevelId', 'its billing rate level'],
  ],
  item: [
    ['type', 'its type'],
    ['incomeAccountId', 'its income account'],
    ['expenseAccountId', 'its expense / COGS account'],
    ['assetAccountId', 'its inventory asset account'],
    ['trackingMode', 'serial / lot tracking'],
    ['uomSetId', 'its unit of measure set'],
    ['isActive', 'whether it is active'],
  ],
  other_name: [
    ['isActive', 'whether it is active'],
    ['billingRateLevelId', 'its billing rate level'],
  ],
};

/**
 * Accountant side: a customer, vendor, item or other name can be added and its everyday fields
 * (name, contact details, terms, prices, notes…) edited — they travel in the changes file — but its
 * structure can't change in the copy (QB: no deletes, merges or inactivation; here also no moves
 * in the hierarchy, type, account or currency changes).
 */
export async function assertAccountantListEdit(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  entity: 'customer' | 'vendor' | 'item' | 'other_name',
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<void> {
  const changed = STRUCTURAL[entity].find(([k]) => patch[k] !== undefined && !same(patch[k], before[k]));
  if (!changed) return;
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || copy.side !== 'accountant' || importing(copy)) return;
  throw new ServiceError(
    'FORBIDDEN',
    `In an Accountant's Copy you can't change ${changed[1]} (it can't be sent back to your client). You can change its name, contact details, terms, prices and notes. Ask your client to make this change in their file.`,
    { accountantCopy: true, side: copy.side, field: changed[0] },
  );
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
      "This kind of transaction can't be entered in an Accountant's Copy because it can't be sent back to your client. " + ACCOUNTANT_CAN,
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
