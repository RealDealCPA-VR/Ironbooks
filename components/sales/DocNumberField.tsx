'use client';
/**
 * Typed document numbers on the sales / purchase forms (QB "Invoice #", "Estimate No.", ...):
 *
 *  - useDocNumber(docType, open, editingRef)  form state, pre-filled with the next number
 *                                             (GET /api/doc-numbers?docType=) on a new form, or
 *                                             the saved number when editing;
 *  - <DocNumberField>                         the labelled input (+ / - step the number);
 *  - useDuplicateNumberConfirm()              QB's "This number has already been used" warning:
 *                                             run(send) calls send(false); when the server
 *                                             refuses a duplicate (409) it asks, and on "Keep
 *                                             this number" resends with send(true)
 *                                             (allowDuplicateNumber). Render `dialog`.
 */
import * as React from 'react';
import { ConfirmDialog, DocNumberInput, Label } from '@/components/ui';
import { api, ApiError } from '@/lib/client';

export type DocNumberType =
  | 'invoice'
  | 'estimate'
  | 'sales_order'
  | 'sales_receipt'
  | 'credit_memo'
  | 'purchase_order';

/** The number shown for a document: its typed ref number, else the legacy integer. */
export function docNo(refNumber: string | null | undefined, legacy: number | string | null | undefined): string {
  const typed = refNumber?.trim();
  if (typed) return typed;
  return legacy === null || legacy === undefined ? '' : String(legacy);
}

export function useDocNumber(docType: DocNumberType, open: boolean, editingRef: string | null | undefined) {
  const [value, setValue] = React.useState('');
  const editing = editingRef !== undefined && editingRef !== null;
  React.useEffect(() => {
    if (!open) return;
    if (editing) {
      setValue(editingRef ?? '');
      return;
    }
    setValue('');
    let cancelled = false;
    api
      .get<{ nextNumber: string }>(`/api/doc-numbers?docType=${docType}`)
      .then((r) => {
        if (!cancelled) setValue((v) => (v ? v : r.nextNumber ?? ''));
      })
      .catch(() => {
        // Non-fatal: a blank number still gets the next number on save.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, docType, editingRef]);
  /** Request-body value: trimmed, or undefined when blank (server assigns the next number). */
  const payload = value.trim() ? value.trim() : undefined;
  return { value, setValue, payload };
}

export function DocNumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <DocNumberInput
        id={id}
        value={value}
        maxLength={50}
        placeholder="Next number"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function isDuplicateDocNumberError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409 && /number .* is already used/i.test(err.message);
}

export function useDuplicateNumberConfirm() {
  const [pending, setPending] = React.useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);

  const run = React.useCallback(async <T,>(send: (allowDuplicate: boolean) => Promise<T>): Promise<T | undefined> => {
    try {
      return await send(false);
    } catch (err) {
      if (!isDuplicateDocNumberError(err)) throw err;
      const ok = await new Promise<boolean>((resolve) => setPending({ message: err.message, resolve }));
      setPending(null);
      if (!ok) return undefined;
      return send(true);
    }
  }, []);

  const dialog = (
    <ConfirmDialog
      open={!!pending}
      title="Number already used"
      message={pending?.message}
      confirmLabel="Keep this number"
      onConfirm={() => pending?.resolve(true)}
      onClose={() => pending?.resolve(false)}
    />
  );
  return { run, dialog };
}
