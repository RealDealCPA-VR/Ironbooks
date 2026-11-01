/**
 * Void and delete of the non-posting forms — estimates, sales orders and purchase orders (QB:
 * Edit > Void <form> / Edit > Delete <form>, Ctrl+D). Shared rules, used by estimates.ts,
 * salesOrders.ts and purchaseOrders.ts:
 *
 *  - Voiding or deleting needs the Delete right in the form's area (QB: "Delete" covers void and
 *    delete). The routes carry it for DELETE; the void actions go through POST / PATCH routes,
 *    so the services check it too. Trusted contexts (no `access`) pass, as everywhere.
 *  - Accountant's Copy, accountant side: a deletion can't be sent back to the client in the
 *    changes file (the form would simply be missing), so it is refused there. The dividing date
 *    itself (client side: forms dated on or before it are locked) is checked by the callers with
 *    assertDividingDateOpen, exactly as for an edit.
 *  - A deleted form's attached documents go back to the Doc Center inbox (unfiled) instead of
 *    pointing at a record that no longer exists — the files are never lost.
 *  - The audit trail keeps what the Voided/Deleted Transactions report shows for a deleted form:
 *    its number, date, name and amount (auditSnapshot).
 */
import { and, eq } from 'drizzle-orm';
import { attachments } from '@/lib/db/schema';
import type { Area } from '@/lib/permissions/model';
import { type ServiceContext, ServiceError } from './_base';
import { requirePermission } from './access';
import { activeCopy } from './accountantCopy/guard';

export type NonPostingDocType = 'estimate' | 'sales_order' | 'purchase_order';

const AREA: Record<NonPostingDocType, Area> = {
  estimate: 'customers',
  sales_order: 'customers',
  purchase_order: 'vendors',
};

/** The Delete right of the form's area (void and delete both need it). */
export function assertMayVoidOrDelete(ctx: ServiceContext, type: NonPostingDocType): void {
  requirePermission(ctx, AREA[type], 'delete');
}

/**
 * Accountant side of an Accountant's Copy: refuse a change the changes file can't carry back
 * (`what` is the action, e.g. "Deleting an estimate"; `instead` the plain alternative).
 */
export async function refuseInAccountantCopy(ctx: ServiceContext, what: string, instead: string): Promise<void> {
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (!copy || copy.side !== 'accountant') return;
  throw new ServiceError(
    'FORBIDDEN',
    `${what} isn't available in an Accountant's Copy, because it can't be sent back to your client. ${instead}`,
    { accountantCopy: true, side: copy.side },
  );
}

/** Documents filed to a deleted form go back to the Doc Center inbox (unfiled). */
export async function unfileAttachments(ctx: ServiceContext, type: NonPostingDocType, id: string): Promise<number> {
  const rows = await ctx.db
    .update(attachments)
    .set({ entityType: null, entityId: null })
    .where(and(eq(attachments.companyId, ctx.companyId), eq(attachments.entityType, type), eq(attachments.entityId, id)))
    .returning({ id: attachments.id });
  return rows.length;
}

/** "#1001", "#1001 and #1002", "#1001, #1002 and #1003". */
export function listRefs(refs: string[]): string {
  const r = [...new Set(refs)].map((x) => `#${x}`);
  if (r.length <= 1) return r.join('');
  return `${r.slice(0, -1).join(', ')} and ${r[r.length - 1]}`;
}

/**
 * What the audit row of a void / delete keeps, so the Voided/Deleted Transactions report can show
 * a deleted form's number, date, name and amount (its row is gone).
 */
export function auditSnapshot(doc: {
  number: string;
  date: Date | string;
  name: string | null;
  partyKey: 'customerName' | 'vendorName';
  total: string;
  status: string;
  memo?: string | null;
}): Record<string, unknown> {
  return {
    number: doc.number,
    date: doc.date,
    [doc.partyKey]: doc.name,
    total: doc.total,
    status: doc.status,
    ...(doc.memo ? { memo: doc.memo } : {}),
  };
}
