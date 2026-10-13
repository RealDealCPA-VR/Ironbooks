'use client';
/**
 * Shared pieces for the A/R form pages (wave2 sales):
 *  - <ShippingSection>     ship date / via / FOB / tracking # / ship-to / customer P.O. (B6)
 *                          and the "To be printed" / "To be emailed" checkboxes (C7)
 *  - useCreditLimitConfirm  runs a save; on a CREDIT_LIMIT warning asks "Save anyway?" and
 *                          retries with overrideCreditLimit: true (C2)
 *  - <FormSendButtons>     Print (PDF) + Email for any sales form (C7/C8)
 */
import * as React from 'react';
import { Mail, Printer, Truck } from 'lucide-react';
import { Button, ConfirmDialog, Input, Label, Modal, toast, toastError } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { shipToAddressFields, shipToSummary, type ShipToAddress } from '@/lib/shipTo';

export type SalesFormKind = 'invoice' | 'estimate' | 'sales_receipt' | 'credit_memo' | 'sales_order';

export interface ShippingState {
  shipDate: string;
  shipVia: string;
  fob: string;
  trackingNumber: string;
  poNumber: string;
  shipTo: { line1: string; line2: string; city: string; state: string; zip: string };
  toBePrinted: boolean;
  toBeEmailed: boolean;
}

export const EMPTY_SHIPPING: ShippingState = {
  shipDate: '',
  shipVia: '',
  fob: '',
  trackingNumber: '',
  poNumber: '',
  shipTo: { line1: '', line2: '', city: '', state: '', zip: '' },
  toBePrinted: false,
  toBeEmailed: false,
};

type DocShipping = {
  shipDate?: string | null;
  shipVia?: string | null;
  fob?: string | null;
  trackingNumber?: string | null;
  poNumber?: string | null;
  shipTo?: Record<string, string> | null;
  toBePrinted?: boolean | null;
  toBeEmailed?: boolean | null;
};

/** Form state from a saved document. */
export function shippingFromDoc(doc: DocShipping | null | undefined): ShippingState {
  if (!doc) return { ...EMPTY_SHIPPING, shipTo: { ...EMPTY_SHIPPING.shipTo } };
  const st = doc.shipTo ?? {};
  return {
    shipDate: doc.shipDate ? String(doc.shipDate).slice(0, 10) : '',
    shipVia: doc.shipVia ?? '',
    fob: doc.fob ?? '',
    trackingNumber: doc.trackingNumber ?? '',
    poNumber: doc.poNumber ?? '',
    shipTo: {
      line1: st.line1 ?? st.street ?? '',
      line2: st.line2 ?? '',
      city: st.city ?? '',
      state: st.state ?? '',
      zip: st.zip ?? st.postalCode ?? '',
    },
    toBePrinted: Boolean(doc.toBePrinted),
    toBeEmailed: Boolean(doc.toBeEmailed),
  };
}

/** Request-body fields for a document (blank → null). */
export function shippingPayload(s: ShippingState, opts?: { shipping?: boolean; shipToOnly?: boolean }) {
  const flags = { toBePrinted: s.toBePrinted, toBeEmailed: s.toBeEmailed };
  if (opts?.shipping === false) return flags;
  const shipTo = Object.fromEntries(
    Object.entries(s.shipTo).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]),
  );
  if (opts?.shipToOnly) return { ...flags, shipTo: Object.keys(shipTo).length ? shipTo : null };
  return {
    ...flags,
    shipDate: s.shipDate ? new Date(s.shipDate).toISOString() : null,
    shipVia: s.shipVia.trim() || null,
    fob: s.fob.trim() || null,
    trackingNumber: s.trackingNumber.trim() || null,
    poNumber: s.poNumber.trim() || null,
    shipTo: Object.keys(shipTo).length ? shipTo : null,
  };
}

/** The customer's sales defaults a form pre-fills (QB: tax item, tax code, ship-to). */
export interface CustomerSalesDefaults {
  taxRateId: string | null;
  /** false = the customer's tax code is non-taxable. */
  taxable: boolean;
  shipTos: ShipToAddress[];
}

/**
 * Load the selected customer's sales defaults (tax item, taxable tax code, named ship-to
 * addresses). Returns null until loaded / when no customer is selected.
 */
export function useCustomerSalesDefaults(customerId: string | null | undefined): CustomerSalesDefaults | null {
  const [state, setState] = React.useState<{ id: string; d: CustomerSalesDefaults } | null>(null);
  React.useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    api
      .get<{
        taxRateId?: string | null;
        taxable?: boolean;
        shipToAddresses?: ShipToAddress[] | null;
        shippingAddress?: Record<string, string> | null;
      }>(`/api/customers/${customerId}`)
      .then((c) => {
        if (cancelled) return;
        const list =
          c.shipToAddresses && c.shipToAddresses.length
            ? c.shipToAddresses
            : c.shippingAddress && Object.values(c.shippingAddress).some((v) => String(v ?? '').trim())
              ? [{ name: 'Ship To 1', ...c.shippingAddress, isDefault: true }]
              : [];
        setState({ id: customerId, d: { taxRateId: c.taxRateId ?? null, taxable: c.taxable !== false, shipTos: list } });
      })
      .catch(() => {
        if (!cancelled) setState({ id: customerId, d: { taxRateId: null, taxable: true, shipTos: [] } });
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  return customerId && state?.id === customerId ? state.d : null;
}

/** Form ship-to state from a named address. */
export function shipToFromAddress(a: ShipToAddress | null | undefined): ShippingState['shipTo'] {
  const f = shipToAddressFields(a);
  return { line1: f.line1 ?? '', line2: f.line2 ?? '', city: f.city ?? '', state: f.state ?? '', zip: f.zip ?? '' };
}

/** The customer's default ship-to (form state), or null when the customer has none. */
export function defaultShipToState(d: CustomerSalesDefaults | null): ShippingState['shipTo'] | null {
  if (!d || d.shipTos.length === 0) return null;
  return shipToFromAddress(d.shipTos.find((a) => a.isDefault) ?? d.shipTos[0]);
}

const sameShipTo = (a: ShippingState['shipTo'], b: ShippingState['shipTo']) =>
  (['line1', 'line2', 'city', 'state', 'zip'] as const).every((k) => (a[k] ?? '').trim() === (b[k] ?? '').trim());

/** QB "Ship Via" list entries (Lists > Ship Via). Empty when the list can't be read. */
function useShipViaList(enabled: boolean): string[] | null {
  const [names, setNames] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .get<{ entries: Array<{ name: string }> }>('/api/lists/ship-via')
      .then((r) => {
        if (!cancelled) setNames((r.entries ?? []).map((e) => e.name).filter(Boolean));
      })
      .catch(() => {
        if (!cancelled) setNames(null); // no access to the list: fall back to typing
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return names;
}

/** Collapsible "Shipping & delivery" fields + send-queue checkboxes. */
export function ShippingSection({
  value,
  onChange,
  showShipping = true,
  shipToOnly = false,
  shipTos,
  idPrefix = 'ship',
}: {
  value: ShippingState;
  onChange: (next: ShippingState) => void;
  /** false = only the To be printed / To be emailed checkboxes (credit memos). */
  showShipping?: boolean;
  /** true = only the ship-to address (estimates). */
  shipToOnly?: boolean;
  /** The customer's named ship-to addresses (QB Enterprise) for the Ship To dropdown. */
  shipTos?: ShipToAddress[] | null;
  idPrefix?: string;
}) {
  const shipViaNames = useShipViaList(showShipping && !shipToOnly);
  const matchedShipTo = (shipTos ?? []).findIndex((a) => sameShipTo(shipToFromAddress(a), value.shipTo));
  const hasShipping =
    !!(value.shipDate || value.shipVia || value.fob || value.trackingNumber || value.poNumber) ||
    Object.values(value.shipTo).some((v) => v.trim());
  const [open, setOpen] = React.useState(hasShipping);
  React.useEffect(() => {
    if (hasShipping) setOpen(true);
  }, [hasShipping]);
  const set = (patch: Partial<ShippingState>) => onChange({ ...value, ...patch });
  const setTo = (patch: Partial<ShippingState['shipTo']>) => onChange({ ...value, shipTo: { ...value.shipTo, ...patch } });

  return (
    <div className="rounded-xl border border-slate-100 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-navy/80">
          <input
            type="checkbox"
            checked={value.toBePrinted}
            onChange={(e) => set({ toBePrinted: e.target.checked })}
          />
          To be printed
        </label>
        <label className="flex items-center gap-2 text-sm text-navy/80">
          <input
            type="checkbox"
            checked={value.toBeEmailed}
            onChange={(e) => set({ toBeEmailed: e.target.checked })}
          />
          To be emailed
        </label>
        {showShipping && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-sm text-electric hover:underline"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <Truck className="h-4 w-4" /> {open ? 'Hide shipping details' : shipToOnly ? 'Add ship-to address' : 'Add shipping details'}
          </button>
        )}
      </div>
      {showShipping && open && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {!shipToOnly && (
            <>
              <div>
                <Label htmlFor={`${idPrefix}-po`}>Customer P.O. number</Label>
                <Input id={`${idPrefix}-po`} value={value.poNumber} onChange={(e) => set({ poNumber: e.target.value })} />
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-date`}>Ship date</Label>
                <Input id={`${idPrefix}-date`} type="date" value={value.shipDate} onChange={(e) => set({ shipDate: e.target.value })} />
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-via`}>Ship via</Label>
                {shipViaNames && shipViaNames.length > 0 ? (
                  <select
                    id={`${idPrefix}-via`}
                    value={value.shipVia}
                    onChange={(e) => set({ shipVia: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-2 focus:ring-electric/30"
                  >
                    <option value="">—</option>
                    {value.shipVia && !shipViaNames.includes(value.shipVia) && (
                      <option value={value.shipVia}>{value.shipVia}</option>
                    )}
                    {shipViaNames.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={`${idPrefix}-via`}
                    placeholder="UPS, FedEx, our truck…"
                    value={value.shipVia}
                    onChange={(e) => set({ shipVia: e.target.value })}
                  />
                )}
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-fob`}>F.O.B. (where ownership passes)</Label>
                <Input id={`${idPrefix}-fob`} placeholder="e.g. Origin" value={value.fob} onChange={(e) => set({ fob: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor={`${idPrefix}-trk`}>Tracking number</Label>
                <Input id={`${idPrefix}-trk`} value={value.trackingNumber} onChange={(e) => set({ trackingNumber: e.target.value })} />
              </div>
            </>
          )}
          <div className="sm:col-span-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <Label htmlFor={`${idPrefix}-l1`}>Ship to</Label>
              {shipTos && shipTos.length > 0 && (
                <select
                  aria-label="Ship to address"
                  value={matchedShipTo >= 0 ? String(matchedShipTo) : ''}
                  onChange={(e) => {
                    const a = shipTos[Number(e.target.value)];
                    if (a) setTo(shipToFromAddress(a));
                  }}
                  className="mb-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none focus:border-electric"
                >
                  <option value="">{matchedShipTo >= 0 ? '' : 'Other address'}</option>
                  {shipTos.map((a, i) => (
                    <option key={`${a.name}-${i}`} value={String(i)}>
                      {shipToSummary(a)}{a.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-6 gap-2">
              <Input id={`${idPrefix}-l1`} className="sm:col-span-3" placeholder="Street" value={value.shipTo.line1} onChange={(e) => setTo({ line1: e.target.value })} />
              <Input className="sm:col-span-3" placeholder="Suite / line 2" aria-label="Ship to line 2" value={value.shipTo.line2} onChange={(e) => setTo({ line2: e.target.value })} />
              <Input className="sm:col-span-3" placeholder="City" aria-label="Ship to city" value={value.shipTo.city} onChange={(e) => setTo({ city: e.target.value })} />
              <Input className="sm:col-span-1" placeholder="State" aria-label="Ship to state" value={value.shipTo.state} onChange={(e) => setTo({ state: e.target.value })} />
              <Input className="sm:col-span-2" placeholder="ZIP" aria-label="Ship to ZIP" value={value.shipTo.zip} onChange={(e) => setTo({ zip: e.target.value })} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Soft-warning flow for sales saves (C2). `run(fn)` calls fn(false, false). When the server
 * answers with a CREDIT_LIMIT warning it asks "Save anyway?" and, if the user agrees, retries
 * with the first flag (overrideCreditLimit) set; a PROGRESS_OVERBILL warning (a line bills more
 * than 100% of its estimate line) does the same with the second flag (allowOverBilling). Each
 * warning is asked about separately. Resolves with fn's result, or undefined when the user
 * cancelled. Other errors propagate.
 */
export function useCreditLimitConfirm() {
  const [pending, setPending] = React.useState<{
    title: string;
    message: string;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const run = React.useCallback(
    async <T,>(fn: (override: boolean, allowOverBilling: boolean) => Promise<T>): Promise<T | undefined> => {
      let override = false;
      let allowOverBilling = false;
      for (;;) {
        try {
          return await fn(override, allowOverBilling);
        } catch (err) {
          const code = err instanceof ApiError ? err.code : undefined;
          const isLimit = code === 'CREDIT_LIMIT' && !override;
          const isOverbill = code === 'PROGRESS_OVERBILL' && !allowOverBilling;
          if (!isLimit && !isOverbill) throw err;
          const title = isLimit ? 'Over the credit limit' : 'More than the estimate';
          const ok = await new Promise<boolean>((resolve) =>
            setPending({ title, message: (err as Error).message, resolve }),
          );
          setPending(null);
          if (!ok) return undefined;
          if (isLimit) override = true;
          else allowOverBilling = true;
        }
      }
    },
    [],
  );

  const dialog = (
    <ConfirmDialog
      open={!!pending}
      title={pending?.title ?? 'Save anyway?'}
      message={
        <>
          {pending?.message}
          <br />
          <span className="text-navy/50">Saving anyway is recorded in the audit trail.</span>
        </>
      }
      confirmLabel="Save anyway"
      onConfirm={() => pending?.resolve(true)}
      onClose={() => pending?.resolve(false)}
    />
  );
  return { run, dialog };
}

/** Print (opens the PDF) + Email (asks for the address) buttons for a saved sales form. */
export function FormSendButtons({
  kind,
  id,
  defaultEmail,
  size = 'sm',
  onSent,
}: {
  kind: SalesFormKind;
  id: string;
  defaultEmail?: string | null;
  size?: 'sm' | 'md';
  onSent?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [to, setTo] = React.useState(defaultEmail ?? '');
  const [sending, setSending] = React.useState(false);
  async function send() {
    setSending(true);
    try {
      const r = await api.post<{ to: string }>(`/api/sales-forms/${kind}/${id}/email`, to.trim() ? { to: to.trim() } : {});
      toast(`Emailed to ${r.to}.`, 'success');
      setOpen(false);
      onSent?.();
    } catch (err) {
      toastError(err, 'Could not send the email.');
    } finally {
      setSending(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size={size}
        title="Print / save as PDF"
        aria-label="Print or save as PDF"
        onClick={() => window.open(`/api/sales-forms/${kind}/${id}/pdf`, '_blank', 'noopener')}
      >
        <Printer className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size={size} title="Email" aria-label="Email this form" onClick={() => { setTo(defaultEmail ?? ''); setOpen(true); }}>
        <Mail className="h-4 w-4" />
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Email this form"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={sending} onClick={send}>Send</Button>
          </>
        }
      >
        <Label htmlFor={`email-${id}`}>Send to</Label>
        <Input
          id={`email-${id}`}
          type="email"
          placeholder="Leave blank to use the customer's email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <p className="mt-2 text-xs text-navy/50">The form is attached as a PDF.</p>
      </Modal>
    </>
  );
}
