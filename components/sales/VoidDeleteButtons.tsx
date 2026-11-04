'use client';
/**
 * Void / Delete of the non-posting forms — estimates, sales orders, purchase orders (QB: Edit >
 * Void <form> / Edit > Delete <form>; Ctrl+D presses the Delete button of the open form or the
 * selected row, components/KeyboardCommands.tsx). Each asks QuickBooks' confirmation first, then
 * calls the form's existing route:
 *   estimate        void  POST /api/estimates/:id { action: 'void' }        delete DELETE /api/estimates/:id
 *   sales order     void  POST /api/sales-orders/:id { action: 'status', status: 'void' }
 *                                                                           delete DELETE /api/sales-orders/:id
 *   purchase order  void  POST /api/purchase-orders/:id { action: 'void' }  delete DELETE /api/purchase-orders/:id
 * Both need the Delete right of the form's area (the server checks it too); the buttons are hidden
 * without it. The server refuses a form an invoice / bill / receipt was made from, with a plain message.
 */
import * as React from 'react';
import { Ban, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { canDo, useMe } from '@/lib/usePermissions';

export type VoidDeleteKind = 'estimate' | 'sales_order' | 'purchase_order';

const CONFIG: Record<VoidDeleteKind, { noun: string; base: string; area: 'customers' | 'vendors'; voidBody: Record<string, unknown> }> = {
  estimate: { noun: 'estimate', base: '/api/estimates', area: 'customers', voidBody: { action: 'void' } },
  sales_order: { noun: 'sales order', base: '/api/sales-orders', area: 'customers', voidBody: { action: 'status', status: 'void' } },
  purchase_order: { noun: 'purchase order', base: '/api/purchase-orders', area: 'vendors', voidBody: { action: 'void' } },
};

export interface VoidDeleteTarget {
  id: string;
  /** Shown in the confirmation ("Estimate #1001"). */
  number: string;
  status: string;
}

/** True when the signed-in user may void / delete this kind of form (unknown rights → true). */
export function useCanVoidDelete(kind: VoidDeleteKind): boolean {
  const { me } = useMe();
  return canDo(me, CONFIG[kind].area, 'delete');
}

/**
 * The confirmation + action for one page. `request(target, 'void' | 'delete')` opens QB's
 * confirmation; `dialog` must be rendered once. `onDone` runs after a successful void / delete.
 */
export function useVoidDelete(kind: VoidDeleteKind, onDone: (what: 'void' | 'delete', id: string) => void | Promise<void>) {
  const cfg = CONFIG[kind];
  const [pending, setPending] = React.useState<{ target: VoidDeleteTarget; what: 'void' | 'delete' } | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function confirm() {
    if (!pending) return;
    const { target, what } = pending;
    setBusy(true);
    try {
      if (what === 'void') await api.post(`${cfg.base}/${target.id}`, cfg.voidBody);
      else await api.del(`${cfg.base}/${target.id}`);
      const label = `${cfg.noun.charAt(0).toUpperCase()}${cfg.noun.slice(1)}${target.number ? ` #${target.number}` : ''}`;
      toast(`${label} ${what === 'void' ? 'voided' : 'deleted'}.`, 'success');
      setPending(null);
      await onDone(what, target.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `Could not ${what} the ${cfg.noun}.`, 'danger');
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <ConfirmDialog
      open={!!pending}
      title={pending?.what === 'void' ? `Void ${cfg.noun}` : `Delete ${cfg.noun}`}
      message={
        pending?.what === 'void'
          ? `Are you sure you want to void this transaction?${pending.target.number ? ` (${cfg.noun} #${pending.target.number})` : ''} It stays in your records marked VOID and can no longer be changed.`
          : `Are you sure you want to delete this transaction?${pending?.target.number ? ` (${cfg.noun} #${pending.target.number})` : ''} It is listed on the Voided/Deleted Transactions report.`
      }
      confirmLabel={pending?.what === 'void' ? 'Void' : 'Delete'}
      tone="danger"
      loading={busy}
      onConfirm={() => void confirm()}
      onClose={() => setPending(null)}
    />
  );

  const request = React.useCallback((target: VoidDeleteTarget, what: 'void' | 'delete') => setPending({ target, what }), []);
  return { request, dialog };
}

/**
 * The "Void" and "Delete" buttons (labels KeyboardCommands' Ctrl+D looks for). `canVoid` /
 * `canDelete` say which the form's status allows; nothing renders without the Delete right.
 */
export function VoidDeleteButtons({
  target,
  allowed,
  canVoid,
  canDelete = true,
  request,
  size = 'sm',
  compact = false,
}: {
  target: VoidDeleteTarget;
  allowed: boolean;
  canVoid: boolean;
  canDelete?: boolean;
  request: (target: VoidDeleteTarget, what: 'void' | 'delete') => void;
  size?: 'sm' | 'md';
  /** Row action: icon + short label, ghost style. */
  compact?: boolean;
}) {
  if (!allowed) return null;
  return (
    <>
      {canVoid && (
        <Button
          type="button"
          variant="ghost"
          size={size}
          className="text-red-600 hover:bg-red-50"
          onClick={() => request(target, 'void')}
          title="Void (keeps it in your records marked VOID)"
        >
          {compact && <Ban className="h-3.5 w-3.5" />} Void
        </Button>
      )}
      {canDelete && (
        <Button
          type="button"
          variant="ghost"
          size={size}
          className="text-red-600 hover:bg-red-50"
          onClick={() => request(target, 'delete')}
          title="Delete (Ctrl+D)"
        >
          {compact && <Trash2 className="h-3.5 w-3.5" />} Delete
        </Button>
      )}
    </>
  );
}
