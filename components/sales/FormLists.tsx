'use client';
/**
 * QuickBooks list pickers on the sales forms (team salesar; the rules live in
 * lib/salesFormListsClient.ts, the server side in lib/services/salesFormLists.ts):
 *  - <CustomerMessageField>  QB's "Customer Message" drop-down under the lines (B8)
 *  - <LineTaxCodeCell>       a line's Sales Tax Code ("Tax" / "Non" / custom), QB's "Tax" column (B9)
 *  - <PaymentMethodField>    a Payment Method list entry with its type (B7, sales receipts)
 *  - useSalesTaxCodes / useCustomerMessages / usePaymentMethods  the list entries (inactive ones
 *    included so a saved document still shows its entry; the pickers offer only active ones).
 * All are native selects: Tab / arrow keys / type-ahead work as on every other field.
 */
import * as React from 'react';
import { Label, Select } from '@/components/ui';
import { api } from '@/lib/client';
import {
  type CustomerMessageEntry,
  type CustomerTaxStatus,
  type PaymentMethodEntry,
  type TaxCodeEntry,
  type TaxCodedRow,
  customerMessageChoices,
  lineTakesTaxCode,
  paymentMethodChoices,
  shownLineTaxCode,
  taxableForCode,
  taxCodeChoices,
  taxCodeLabel,
} from '@/lib/salesFormListsClient';

type ListKey = 'sales-tax-codes' | 'customer-messages' | 'payment-methods';

/** Entries of a simple list (inactive included). Empty while loading or when the list can't be read. */
function useListEntries<T>(key: ListKey, enabled: boolean): T[] {
  const [rows, setRows] = React.useState<T[]>([]);
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    api
      .get<{ entries: T[] }>(`/api/lists/${key}?includeInactive=true`)
      .then((r) => {
        if (live) setRows(Array.isArray(r?.entries) ? r.entries : []);
      })
      .catch(() => {
        // No access to the list: the forms fall back to what they did before (Tax checkbox,
        // payment types, no message picker).
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [key, enabled]);
  return rows;
}

export function useSalesTaxCodes(enabled: boolean): TaxCodeEntry[] {
  return useListEntries<TaxCodeEntry>('sales-tax-codes', enabled);
}

export function useCustomerMessages(enabled: boolean): CustomerMessageEntry[] {
  return useListEntries<CustomerMessageEntry>('customer-messages', enabled);
}

export function usePaymentMethods(enabled: boolean): PaymentMethodEntry[] {
  return useListEntries<PaymentMethodEntry>('payment-methods', enabled);
}

/** The customer's tax status from useCustomerSalesDefaults (null until loaded / no customer). */
export function customerTaxStatus(
  d: { taxable: boolean; salesTaxCodeId?: string | null } | null | undefined,
): CustomerTaxStatus | null {
  return d ? { taxable: d.taxable, salesTaxCodeId: d.salesTaxCodeId ?? null } : null;
}

// ---------------------------------------------------------------------------
// Customer Message (B8)
// ---------------------------------------------------------------------------

export function CustomerMessageField({
  id,
  value,
  onChange,
  messages,
  className,
}: {
  id: string;
  /** The picked entry id ('' = no message). */
  value: string;
  onChange: (id: string) => void;
  messages: CustomerMessageEntry[];
  className?: string;
}) {
  const choices = customerMessageChoices(messages, value);
  return (
    <div className={className}>
      <Label htmlFor={id}>
        Customer Message <span className="font-normal text-navy/50">(printed on the form)</span>
      </Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No message</option>
        {/* A saved message the list can't show (no access to the list): keep it selectable. */}
        {value && !choices.some((m) => m.id === value) && <option value={value}>(saved message)</option>}
        {choices.map((m) => (
          <option key={m.id} value={m.id}>
            {m.message}
            {m.isActive === false ? ' (inactive)' : ''}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sales Tax Code per line (B9)
// ---------------------------------------------------------------------------

/**
 * A line's Sales Tax Code. Without the code list (still loading, or no access) it falls back to
 * the Tax checkbox the forms had before. Subtotal / payment / sales-tax lines carry no code.
 */
export function LineTaxCodeCell({
  row,
  codes,
  customer,
  onChange,
  label,
  className,
  disabled = false,
}: {
  row: TaxCodedRow;
  codes: TaxCodeEntry[];
  customer: CustomerTaxStatus | null | undefined;
  onChange: (patch: { salesTaxCodeId: string; taxable: boolean }) => void;
  /** Accessible name, e.g. "Line 2 sales tax code". */
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const nonCustomer = !!customer && !customer.taxable;
  const title = nonCustomer
    ? "This customer's sales tax code is non-taxable: no sales tax is charged on this form."
    : 'Sales tax code: taxable or non-taxable';
  if (!lineTakesTaxCode(row.itemType)) {
    return (
      <Select aria-label={label} value="" disabled className={`px-1.5 py-1 text-xs ${className ?? ''}`}>
        <option value="">—</option>
      </Select>
    );
  }
  if (codes.length === 0) {
    return (
      <label className={`flex items-center justify-center gap-1 text-xs text-navy/60 select-none ${className ?? ''}`}>
        <input
          type="checkbox"
          checked={row.taxable && !nonCustomer}
          disabled={disabled || nonCustomer}
          onChange={(e) => onChange({ salesTaxCodeId: '', taxable: e.target.checked })}
          className="h-4 w-4 accent-electric"
          aria-label={label}
          title={title}
        />
        <span aria-hidden="true">Tax</span>
      </label>
    );
  }
  const shown = shownLineTaxCode(row, codes, customer);
  const choices = taxCodeChoices(codes, shown.salesTaxCodeId, customer);
  return (
    <Select
      aria-label={label}
      title={title}
      value={shown.salesTaxCodeId}
      disabled={disabled}
      onChange={(e) => {
        const id = e.target.value;
        onChange({ salesTaxCodeId: id, taxable: taxableForCode(id, codes, row.taxable) });
      }}
      className={`px-1.5 py-1 text-xs ${className ?? ''}`}
    >
      {!shown.salesTaxCodeId && <option value="">—</option>}
      {choices.map((c) => (
        <option key={c.id} value={c.id} title={c.description ?? undefined}>
          {taxCodeLabel(c)}
        </option>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Payment Method (B7)
// ---------------------------------------------------------------------------

export function PaymentMethodField({
  id,
  value,
  onChange,
  entries,
}: {
  id: string;
  /** `pm:<entry id>` or `type:<type>` (lib/salesFormListsClient.ts paymentMethodValue). */
  value: string;
  onChange: (value: string) => void;
  entries: PaymentMethodEntry[];
}) {
  const choices = paymentMethodChoices(entries, value);
  return (
    <>
      <Label htmlFor={id}>Payment Method</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {!choices.some((c) => c.value === value) && <option value={value}>(saved payment method)</option>}
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
    </>
  );
}
