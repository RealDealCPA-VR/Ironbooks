'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { FileText, Plus, Trash2, PlusCircle, MinusCircle, Download, Mail, Package, Pencil, Send } from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Input,
  Select,
  useGridKeys,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  Spinner,
  toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { useFocusParam, useNewParam } from '@/lib/useFocusParam';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
}

type ItemType =
  | 'service' | 'inventory' | 'non_inventory' | 'bundle'
  | 'other_charge' | 'discount' | 'subtotal' | 'payment' | 'sales_tax';

interface Item {
  id: string;
  name: string;
  type: ItemType;
  description: string | null;
  salesPrice: string | null;
  taxable: boolean;
  quantityOnHand: string | null;
  unitOfMeasure: string | null;
}

interface BundleComponent {
  componentItemId: string;
  quantity: string;
  name: string;
  type: ItemType;
  description: string | null;
  salesPrice: string | null;
  taxable: boolean;
  unitOfMeasure: string | null;
}

interface TaxRate {
  id: string;
  name: string;
  rate: string; // fraction, e.g. "0.082500"
}

interface ClassRow {
  id: string;
  name: string;
}

interface Job {
  id: string;
  name: string;
  customerId: string | null;
}

type InvoiceStatus = 'draft' | 'open' | 'partial' | 'paid' | 'void';

interface Invoice {
  id: string;
  invoiceNumber: number;
  customerId: string;
  date: string;
  dueDate: string | null;
  total: string;
  balanceDue: string;
  status: InvoiceStatus;
}

/** Full invoice (GET /api/invoices/:id) used to prefill the edit modal. */
interface InvoiceDetail extends Invoice {
  taxRateId: string | null;
  classId: string | null;
  discount: string;
  discountType: 'amount' | 'percent' | null;
  currency: string | null;
  exchangeRate: string | null;
  memo: string | null;
  customFields: Record<string, string> | null;
  lines: Array<{
    id: string;
    itemId: string | null;
    description: string | null;
    quantity: string;
    rate: string;
    taxable: boolean;
    jobId: string | null;
    itemName: string | null;
    itemType: ItemType | null;
    unitOfMeasure: string | null;
  }>;
}

interface LineRow {
  /** Find-as-you-type item field (datalist); itemId resolves on exact name match. */
  itemName: string;
  itemId: string | null;
  itemType: ItemType | null;
  unitOfMeasure: string | null;
  description: string;
  quantity: string;
  rate: string;
  taxable: boolean;
  jobId: string;
  /** Discount items only: interpret `rate` as a % of the preceding body lines. */
  discountPercent: boolean;
}

/** Unbilled billable time & costs (GET /api/billables?customerId=). */
interface BillableCost {
  id: string;
  source: 'bill' | 'expense';
  date: string;
  ref: string | null;
  description: string | null;
  amount: string;
  jobId: string | null;
}

interface BillableTime {
  id: string;
  date: string;
  description: string | null;
  hours: string;
  rate: string;
  amount: string;
  serviceItemId: string | null;
  jobId: string | null;
}

interface Billables {
  costs: BillableCost[];
  time: BillableTime[];
}

interface CustomerPrice {
  itemId: string;
  price: string;
}

interface CustomFieldDef {
  name: string;
}

type DiscountType = 'amount' | 'percent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusLabel(status: InvoiceStatus): string {
  if (status === 'draft') return 'Pending';
  if (status === 'open') return 'Open';
  if (status === 'partial') return 'Partial';
  if (status === 'paid') return 'Paid';
  return 'Void';
}

type LineKind = 'income' | 'discount' | 'subtotal' | 'payment' | 'sales_tax';

function lineKind(l: { itemType: ItemType | null }): LineKind {
  if (l.itemType === 'discount' || l.itemType === 'subtotal' ||
      l.itemType === 'payment' || l.itemType === 'sales_tax') {
    return l.itemType;
  }
  return 'income';
}

const KIND_BADGES: Partial<Record<ItemType, { label: string; tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral' }>> = {
  bundle: { label: 'Bundle', tone: 'neutral' },
  discount: { label: 'Discount', tone: 'danger' },
  subtotal: { label: 'Subtotal', tone: 'neutral' },
  payment: { label: 'Payment', tone: 'success' },
  sales_tax: { label: 'Sales Tax', tone: 'warning' },
  other_charge: { label: 'Other Charge', tone: 'info' },
};

interface LiveTotals {
  /** Computed amount per line (same index as the lines array). */
  amounts: number[];
  subtotal: number;
  discount: number;
  tax: number;
  payments: number;
  total: number;
  balanceDue: number;
}

/**
 * Mirror the service math, item-type aware:
 *  - income lines add to the subtotal (+ taxable base when taxed)
 *  - discount lines subtract (flat qty*rate, or % of the preceding body lines)
 *  - subtotal lines display the running body sum (and reset the group)
 *  - payment lines reduce the balance due (not the subtotal)
 *  - sales_tax lines add straight to the tax amount
 * Selected billables flow in as extra non-taxable income.
 */
function computeTotals(
  lines: LineRow[],
  discount: string,
  discountType: DiscountType,
  taxRate: number,
  billablesAmount: number,
): LiveTotals {
  let subtotal = 0;
  let taxableSubtotal = 0;
  let payments = 0;
  let manualTax = 0;
  let running = 0;
  const amounts: number[] = [];

  for (const l of lines) {
    const kind = lineKind(l);
    if (kind === 'subtotal') {
      amounts.push(running);
      running = 0;
      continue;
    }
    const qty = parseFloat(l.quantity) || 0;
    const rate = parseFloat(l.rate) || 0;
    let amt: number;
    if (kind === 'discount') {
      amt = l.discountPercent
        ? -(running * (Math.abs(rate) / 100))
        : -Math.abs((qty || 1) * rate);
    } else {
      amt = qty * rate;
    }
    amounts.push(amt);

    if (kind === 'income' || kind === 'discount') {
      subtotal += amt;
      running += amt;
      if (l.taxable) taxableSubtotal += amt;
    } else if (kind === 'payment') {
      payments += amt;
    } else if (kind === 'sales_tax') {
      manualTax += amt;
    }
  }

  subtotal += billablesAmount;
  const discValue = parseFloat(discount) || 0;
  const discAmount = discountType === 'percent' ? subtotal * (discValue / 100) : discValue;
  const tax = Math.max(0, taxableSubtotal) * taxRate + manualTax;
  const total = Math.max(0, subtotal - discAmount + tax);
  return {
    amounts,
    subtotal,
    discount: discAmount,
    tax,
    payments,
    total,
    balanceDue: Math.max(0, total - payments),
  };
}

const EMPTY_LINE: LineRow = {
  itemName: '',
  itemId: null,
  itemType: null,
  unitOfMeasure: null,
  description: '',
  quantity: '',
  rate: '',
  taxable: true,
  jobId: '',
  discountPercent: false,
};

// ---------------------------------------------------------------------------
// Invoice Modal (create + edit)
// ---------------------------------------------------------------------------

interface InvoiceModalProps {
  open: boolean;
  /** Full invoice to prefill — null = create mode. */
  editing: InvoiceDetail | null;
  onClose: () => void;
  customers: Customer[];
  items: Item[];
  taxRates: TaxRate[];
  classes: ClassRow[];
  jobs: Job[];
  customFieldDefs: CustomFieldDef[];
  onSaved: () => void;
}

function InvoiceModal({
  open,
  editing,
  onClose,
  customers,
  items,
  taxRates,
  classes,
  jobs,
  customFieldDefs,
  onSaved,
}: InvoiceModalProps) {
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [taxRateId, setTaxRateId] = useState('');
  const [classId, setClassId] = useState('');
  const [discount, setDiscount] = useState('');
  const [discountType, setDiscountType] = useState<DiscountType>('amount');
  const [currency, setCurrency] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);
  const [saveAsPending, setSaveAsPending] = useState(false);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  // Customer price levels: itemId → custom price for the selected customer.
  const [customerPrices, setCustomerPrices] = useState<Map<string, string>>(new Map());

  // Billable time & costs (create mode only).
  const [billables, setBillables] = useState<Billables | null>(null);
  const [selectedCostIds, setSelectedCostIds] = useState<Set<string>>(new Set());
  const [selectedTimeIds, setSelectedTimeIds] = useState<Set<string>>(new Set());
  const [markupPercent, setMarkupPercent] = useState('');

  const itemNameById = new Map(items.map((it) => [it.id, it.name]));

  // Reset / prefill form when the modal opens.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCustomerId(editing.customerId);
      setDate(editing.date ? editing.date.slice(0, 10) : new Date().toISOString().slice(0, 10));
      setDueDate(editing.dueDate ? editing.dueDate.slice(0, 10) : '');
      setTaxRateId(editing.taxRateId ?? '');
      setClassId(editing.classId ?? '');
      // The stored discount is the resolved dollar amount — prefill as a flat amount.
      setDiscount(Number(editing.discount) > 0 ? editing.discount : '');
      setDiscountType('amount');
      setCurrency(editing.currency ?? '');
      setExchangeRate(
        editing.currency && editing.exchangeRate ? String(Number(editing.exchangeRate)) : '',
      );
      setMemo(editing.memo ?? '');
      setSaveAsPending(editing.status === 'draft');
      setCustomValues(editing.customFields ?? {});
      setLines(
        editing.lines.map((l) => ({
          itemName: l.itemName ?? (l.itemId ? (itemNameById.get(l.itemId) ?? '') : ''),
          itemId: l.itemId,
          itemType: l.itemType,
          unitOfMeasure: l.unitOfMeasure,
          description: l.description ?? '',
          quantity: String(Number(l.quantity)),
          rate: String(Number(l.rate)),
          taxable: l.taxable,
          jobId: l.jobId ?? '',
          discountPercent: false,
        })),
      );
    } else {
      setCustomerId('');
      setDate(new Date().toISOString().slice(0, 10));
      setDueDate('');
      setTaxRateId('');
      setClassId('');
      setDiscount('');
      setDiscountType('amount');
      setCurrency('');
      setExchangeRate('');
      setMemo('');
      setSaveAsPending(false);
      setCustomValues({});
      setLines([{ ...EMPTY_LINE }]);
    }
    setBillables(null);
    setSelectedCostIds(new Set());
    setSelectedTimeIds(new Set());
    setMarkupPercent('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // When a customer is selected: load their price level + unbilled billables.
  useEffect(() => {
    if (!open || !customerId) {
      setCustomerPrices(new Map());
      setBillables(null);
      setSelectedCostIds(new Set());
      setSelectedTimeIds(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ prices: CustomerPrice[] }>(
          `/api/customer-prices?customerId=${customerId}`,
        );
        if (!cancelled) {
          setCustomerPrices(new Map((res.prices ?? []).map((p) => [p.itemId, p.price])));
        }
      } catch {
        // Non-fatal — fall back to item sales prices.
      }
      if (!editing) {
        try {
          const b = await api.get<Billables>(`/api/billables?customerId=${customerId}`);
          if (!cancelled) {
            setBillables(b);
            setSelectedCostIds(new Set());
            setSelectedTimeIds(new Set());
          }
        } catch {
          // Non-fatal — billables section just won't show.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, customerId, editing]);

  function updateLine(idx: number, patch: Partial<LineRow>) {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  /** Expand a bundle item into its component lines (printed grouped under the bundle name). */
  async function expandBundle(idx: number, bundle: Item) {
    try {
      const res = await api.get<{ components: BundleComponent[] }>(
        `/api/items/${bundle.id}/components`,
      );
      const comps = res.components ?? [];
      if (comps.length === 0) {
        toast(`Bundle "${bundle.name}" has no components yet — added as a plain line.`, 'info');
        return;
      }
      const componentLines: LineRow[] = comps.map((c) => ({
        itemName: c.name,
        itemId: c.componentItemId,
        itemType: c.type,
        unitOfMeasure: c.unitOfMeasure,
        description: `${bundle.name}: ${c.description ?? c.name}`,
        quantity: String(Number(c.quantity)),
        rate:
          customerPrices.get(c.componentItemId) != null
            ? String(Number(customerPrices.get(c.componentItemId)))
            : (c.salesPrice ?? '0'),
        taxable: c.taxable,
        jobId: '',
        discountPercent: false,
      }));
      setLines((prev) => {
        const next = [...prev];
        next.splice(idx, 1, ...componentLines);
        return next;
      });
      toast(`Expanded bundle "${bundle.name}" into ${comps.length} component line${comps.length !== 1 ? 's' : ''}.`, 'success');
    } catch {
      toast('Failed to load bundle components — added as a plain line.', 'danger');
    }
  }

  /** Item field changed: resolve exact (case-insensitive) name → auto-fill the line.
   *  Price levels: a customer-specific price (customer_prices) wins over salesPrice.
   *  Bundles expand into their component lines. Special types pre-fill sensibly. */
  function handleItemInput(idx: number, value: string) {
    const match = items.find((it) => it.name.toLowerCase() === value.trim().toLowerCase());
    if (match) {
      if (match.type === 'bundle') {
        // Replace this row with the bundle's component lines.
        void expandBundle(idx, match);
        return;
      }
      const customerPrice = customerPrices.get(match.id);
      const isSpecial =
        match.type === 'discount' || match.type === 'subtotal' ||
        match.type === 'payment' || match.type === 'sales_tax';
      updateLine(idx, {
        itemName: match.name,
        itemId: match.id,
        itemType: match.type,
        unitOfMeasure: match.unitOfMeasure,
        description: match.description ?? match.name,
        rate:
          match.type === 'subtotal'
            ? ''
            : customerPrice != null
              ? String(Number(customerPrice))
              : (match.salesPrice ?? ''),
        taxable: isSpecial ? match.type === 'discount' && match.taxable : match.taxable,
        quantity: match.type === 'subtotal' ? '' : lines[idx].quantity || '1',
        discountPercent: false,
      });
      if (customerPrice != null && !isSpecial) {
        toast(`Customer price applied for ${match.name}: ${formatCurrency(customerPrice)}`, 'info');
      }
    } else {
      // No item match — stays a manual description line (itemId null).
      updateLine(idx, { itemName: value, itemId: null, itemType: null, unitOfMeasure: null });
    }
  }

  function addLine() {
    setLines((prev) => [...prev, { ...EMPTY_LINE }]);
  }

  function removeLine(idx: number) {
    // Keep at least one line (mirrors the per-row remove button being disabled).
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
  }

  // Ctrl+Insert adds a line, Ctrl+Delete removes the focused row, Enter moves down.
  const grid = useGridKeys({ addRow: addLine, removeRow: removeLine, disabled: saving });

  function toggleCost(id: string) {
    setSelectedCostIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTime(id: string) {
    setSelectedTimeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Jobs available for the selected customer (plus unassigned jobs).
  const customerJobs = jobs.filter((j) => !j.customerId || j.customerId === customerId);
  const selectedRate = taxRates.find((t) => t.id === taxRateId);

  // Selected billables → extra (non-taxable) invoice amount. Markup applies to costs only.
  const markupFactor = 1 + (parseFloat(markupPercent) || 0) / 100;
  const selectedCostsAmount = (billables?.costs ?? [])
    .filter((c) => selectedCostIds.has(c.id))
    .reduce((s, c) => s + Number(c.amount) * markupFactor, 0);
  const selectedTimeAmount = (billables?.time ?? [])
    .filter((t) => selectedTimeIds.has(t.id))
    .reduce((s, t) => s + Number(t.amount), 0);
  const billablesAmount = selectedCostsAmount + selectedTimeAmount;
  const hasBillablesSelected = selectedCostIds.size + selectedTimeIds.size > 0;

  const totals = computeTotals(
    lines,
    discount,
    discountType,
    selectedRate ? parseFloat(selectedRate.rate) || 0 : 0,
    billablesAmount,
  );

  async function handleSubmit() {
    if (!customerId) { toast('Please select a customer.', 'danger'); return; }
    if (!date) { toast('Please enter an invoice date.', 'danger'); return; }

    // Pair each line with its index so per-line live amounts stay aligned.
    const indexed = lines
      .map((l, idx) => ({ l, idx }))
      .filter(({ l }) => l.itemId || l.description || l.quantity || l.rate);
    if (indexed.length === 0 && !hasBillablesSelected) {
      toast('Add at least one line item or select billables.', 'danger'); return;
    }
    for (let i = 0; i < indexed.length; i++) {
      const { l } = indexed[i];
      const kind = lineKind(l);
      if (kind === 'subtotal') continue; // computed server-side
      if (kind === 'discount') {
        if (!l.rate || (parseFloat(l.rate) || 0) === 0) {
          toast(`Line ${i + 1}: enter a discount ${l.discountPercent ? 'percent' : 'amount'}.`, 'danger'); return;
        }
        continue;
      }
      if (!l.quantity || parseFloat(l.quantity) <= 0) {
        toast(`Line ${i + 1}: quantity must be a positive number.`, 'danger'); return;
      }
      if (!l.rate || parseFloat(l.rate) < 0) {
        toast(`Line ${i + 1}: rate cannot be negative.`, 'danger'); return;
      }
    }

    const payload: Record<string, unknown> = {
      customerId,
      date,
      dueDate: dueDate || undefined,
      taxRateId: taxRateId || undefined,
      classId: classId || undefined,
      discount: discount || undefined,
      discountType,
      currency: currency || undefined,
      exchangeRate: exchangeRate || undefined,
      memo: memo || undefined,
      customFields: customFieldDefs.length > 0 ? customValues : undefined,
      lines: indexed.map(({ l, idx }) => {
        const kind = lineKind(l);
        if (kind === 'subtotal') {
          // Server recomputes the amount from the preceding lines.
          return { itemId: l.itemId, description: l.description || null, quantity: 1, rate: 0, taxable: false };
        }
        if (kind === 'discount' && l.discountPercent) {
          // Convert the live %-of-preceding-lines amount into a flat negative rate.
          return {
            itemId: l.itemId,
            description: l.description || null,
            quantity: 1,
            rate: totals.amounts[idx].toFixed(2),
            taxable: l.taxable,
            jobId: l.jobId || null,
          };
        }
        return {
          itemId: l.itemId,
          description: l.description || null,
          quantity: l.quantity,
          rate: l.rate,
          taxable: l.taxable,
          jobId: l.jobId || null,
        };
      }),
    };

    if (!editing) {
      payload.status = saveAsPending ? 'draft' : 'open';
    }

    if (!editing && hasBillablesSelected && billables) {
      payload.billables = {
        billLineIds: billables.costs
          .filter((c) => c.source === 'bill' && selectedCostIds.has(c.id))
          .map((c) => c.id),
        expenseLineIds: billables.costs
          .filter((c) => c.source === 'expense' && selectedCostIds.has(c.id))
          .map((c) => c.id),
        timeEntryIds: billables.time.filter((t) => selectedTimeIds.has(t.id)).map((t) => t.id),
        markupPercent: markupPercent || undefined,
      };
    }

    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/api/invoices/${editing.id}`, payload);
        toast(`Invoice #${editing.invoiceNumber} updated.`, 'success');
      } else {
        await api.post('/api/invoices', payload);
        toast(saveAsPending ? 'Pending invoice saved (not posted).' : 'Invoice created.', 'success');
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to save invoice.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="lg"
      open={open}
      onClose={onClose}
      title={
        editing
          ? `Edit Invoice #${editing.invoiceNumber}${editing.status === 'draft' ? ' (Pending)' : ''}`
          : 'New Invoice'
      }
      footer={
        <>
          {!editing && (
            <label className="mr-auto flex items-center gap-2 text-sm text-navy/70 select-none">
              <input
                type="checkbox"
                checked={saveAsPending}
                onChange={(e) => setSaveAsPending(e.target.checked)}
                className="accent-electric"
              />
              Save as pending (don&apos;t post yet)
            </label>
          )}
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>
            {editing ? 'Save Changes' : saveAsPending ? 'Save Pending' : 'Create Invoice'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editing && editing.status !== 'draft' && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Editing re-posts this invoice&apos;s GL entry (and any COGS). Allowed only while no
            payments are applied and the period is open.
          </div>
        )}
        {editing && editing.status === 'draft' && (
          <div className="rounded-lg bg-navy/5 px-3 py-2 text-xs text-navy/60">
            This invoice is pending — nothing has been posted to the GL yet. Use{' '}
            <span className="font-semibold">Post</span> on the invoice list when it is ready.
          </div>
        )}

        {/* Customer */}
        <div>
          <Label htmlFor="inv-customer" required>Customer</Label>
          <Select
            id="inv-customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            autoFocus
          >
            <option value="">Select a customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </Select>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="inv-date" required>Invoice Date</Label>
            <DateInput
              id="inv-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="inv-due">Due Date</Label>
            <DateInput
              id="inv-due"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>

        {/* Tax rate + class */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="inv-taxrate">Sales Tax</Label>
            <Select
              id="inv-taxrate"
              value={taxRateId}
              onChange={(e) => setTaxRateId(e.target.value)}
            >
              <option value="">No tax</option>
              {taxRates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({(parseFloat(t.rate) * 100).toFixed(2)}%)
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="inv-class">Class <Help term="class" /></Label>
            <Select
              id="inv-class"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
            >
              <option value="">No class</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
        </div>

        {/* Custom fields (company-defined) */}
        {customFieldDefs.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {customFieldDefs.map((f) => (
              <div key={f.name}>
                <Label htmlFor={`inv-cf-${f.name}`}>{f.name}</Label>
                <Input
                  id={`inv-cf-${f.name}`}
                  value={customValues[f.name] ?? ''}
                  onChange={(e) =>
                    setCustomValues((prev) => ({ ...prev, [f.name]: e.target.value }))
                  }
                  placeholder={f.name}
                />
              </div>
            ))}
          </div>
        )}

        {/* Line items */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0">Line Items</Label>
            <button
              type="button"
              onClick={addLine}
              className="text-electric hover:text-electric/80 flex items-center gap-1 text-sm font-medium"
            >
              <PlusCircle className="h-4 w-4" /> Add line
            </button>
          </div>

          {/* Find-as-you-type item options shared by all line rows */}
          <datalist id="inv-item-options">
            {items.map((it) => {
              const typeTag = KIND_BADGES[it.type]?.label;
              const price = formatCurrency(customerPrices.get(it.id) ?? it.salesPrice ?? '0');
              const detail =
                it.type === 'inventory'
                  ? `${price} · ${Number(it.quantityOnHand ?? 0)} on hand`
                  : typeTag
                    ? `${typeTag}${it.type === 'subtotal' ? '' : ` · ${price}`}`
                    : price;
              return (
                <option key={it.id} value={it.name}>
                  {it.unitOfMeasure ? `${detail} · per ${it.unitOfMeasure}` : detail}
                </option>
              );
            })}
          </datalist>

          <div className="rounded-lg border border-slate-200 overflow-hidden" onKeyDown={grid.onKeyDown}>
            {lines.map((line, idx) => {
              const kind = lineKind(line);
              const badge = line.itemType ? KIND_BADGES[line.itemType] : undefined;
              return (
              <div
                key={idx}
                data-grid-row
                className="px-3 py-2 border-b border-slate-100 last:border-b-0 space-y-2"
              >
                {/* Row 1: item lookup + description + remove */}
                <div className="grid grid-cols-[1fr_1.2fr_28px] gap-2 items-center">
                  <Input
                    placeholder="Item (type to search)…"
                    list="inv-item-options"
                    value={line.itemName}
                    onChange={(e) => handleItemInput(idx, e.target.value)}
                    className={line.itemId ? 'border-electric/50' : undefined}
                  />
                  <Input
                    placeholder="Description"
                    value={line.description}
                    onChange={(e) => updateLine(idx, { description: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    disabled={lines.length === 1}
                    className="text-navy/30 hover:text-red-500 disabled:opacity-20 transition-colors flex items-center justify-center"
                    aria-label="Remove line"
                  >
                    <MinusCircle className="h-4 w-4" />
                  </button>
                </div>
                {/* Row 2: qty, rate, job, taxable, amount */}
                <div className="grid grid-cols-[64px_84px_1fr_52px_76px] gap-2 items-center">
                  <AmountInput
                    placeholder="Qty"
                    value={kind === 'subtotal' ? '' : line.quantity}
                    disabled={kind === 'subtotal' || (kind === 'discount' && line.discountPercent)}
                    onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                  />
                  <AmountInput
                    placeholder={kind === 'discount' ? (line.discountPercent ? '%' : 'Amount') : 'Rate'}
                    value={kind === 'subtotal' ? '' : line.rate}
                    disabled={kind === 'subtotal'}
                    onChange={(e) => updateLine(idx, { rate: e.target.value })}
                  />
                  <Select
                    value={line.jobId}
                    onChange={(e) => updateLine(idx, { jobId: e.target.value })}
                    aria-label="Customer:Job"
                  >
                    <option value="">No job</option>
                    {customerJobs.map((j) => (
                      <option key={j.id} value={j.id}>{j.name}</option>
                    ))}
                  </Select>
                  <label className="flex items-center gap-1 text-xs text-navy/60 select-none justify-center">
                    <input
                      type="checkbox"
                      checked={line.taxable}
                      disabled={kind === 'subtotal' || kind === 'payment' || kind === 'sales_tax'}
                      onChange={(e) => updateLine(idx, { taxable: e.target.checked })}
                      className="accent-electric"
                    />
                    Tax
                  </label>
                  <span className="text-right text-xs font-semibold text-navy/70 tabular-nums">
                    {formatCurrency((totals.amounts[idx] ?? 0).toFixed(2))}
                  </span>
                </div>
                {/* Row 3 (special types / UoM): badge + helpers */}
                {(badge || line.unitOfMeasure) && (
                  <div className="flex items-center gap-2 text-xs text-navy/50">
                    {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                    {line.unitOfMeasure && <span>per {line.unitOfMeasure}</span>}
                    {kind === 'subtotal' && (
                      <span>Sum of the lines above — computed automatically.</span>
                    )}
                    {kind === 'payment' && <span>Reduces the balance due (Dr Undeposited Funds / Cr A/R).</span>}
                    {kind === 'sales_tax' && <span>Manual tax amount added to Sales Tax Payable.</span>}
                    {kind === 'discount' && (
                      <label className="flex items-center gap-1 select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={line.discountPercent}
                          onChange={(e) =>
                            updateLine(idx, { discountPercent: e.target.checked, quantity: '1' })
                          }
                          className="accent-electric"
                        />
                        % of the lines above
                      </label>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>

        {/* Billable time & costs (create mode, customer selected, anything unbilled) */}
        {!editing && billables && (billables.costs.length > 0 || billables.time.length > 0) && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="mb-0">Add billable time &amp; costs</Label>
              <div className="flex items-center gap-1 text-xs text-navy/60">
                <span>Markup %</span>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0"
                  value={markupPercent}
                  onChange={(e) => setMarkupPercent(e.target.value)}
                  className="w-16 py-1 text-xs"
                  aria-label="Markup percent on costs"
                />
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 max-h-48 overflow-y-auto">
              {billables.costs.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={selectedCostIds.has(c.id)}
                    onChange={() => toggleCost(c.id)}
                    className="accent-electric"
                  />
                  <Badge tone="neutral">{c.source === 'bill' ? 'Bill' : 'Expense'}</Badge>
                  <span className="text-navy/50">{c.date ? formatDate(c.date) : ''}</span>
                  <span className="flex-1 truncate text-navy/80">
                    {c.description ?? c.ref ?? 'Reimbursable cost'}
                  </span>
                  <span className="tabular-nums font-semibold text-navy/80">
                    {formatCurrency((Number(c.amount) * markupFactor).toFixed(2))}
                  </span>
                </label>
              ))}
              {billables.time.map((t) => (
                <label
                  key={t.id}
                  className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={selectedTimeIds.has(t.id)}
                    onChange={() => toggleTime(t.id)}
                    className="accent-electric"
                  />
                  <Badge tone="info">Time</Badge>
                  <span className="text-navy/50">{t.date ? formatDate(t.date) : ''}</span>
                  <span className="flex-1 truncate text-navy/80">
                    {t.description ?? 'Time entry'} ({Number(t.hours)}h × {formatCurrency(t.rate)})
                  </span>
                  <span className="tabular-nums font-semibold text-navy/80">
                    {formatCurrency(t.amount)}
                  </span>
                </label>
              ))}
            </div>
            {hasBillablesSelected && (
              <p className="mt-1 text-xs text-navy/50">
                {selectedCostIds.size + selectedTimeIds.size} billable item
                {selectedCostIds.size + selectedTimeIds.size !== 1 ? 's' : ''} selected —{' '}
                {formatCurrency(billablesAmount.toFixed(2))} will be added to this invoice.
              </p>
            )}
          </div>
        )}

        {/* Discount */}
        <div>
          <Label>Discount</Label>
          <div className="flex gap-2">
            {/* Type toggle */}
            <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
              <button
                type="button"
                onClick={() => setDiscountType('amount')}
                className={`px-3 py-2 text-xs font-semibold transition-colors ${
                  discountType === 'amount'
                    ? 'bg-electric text-white'
                    : 'bg-white text-navy/60 hover:bg-slate-50'
                }`}
              >
                $
              </button>
              <button
                type="button"
                onClick={() => setDiscountType('percent')}
                className={`px-3 py-2 text-xs font-semibold transition-colors ${
                  discountType === 'percent'
                    ? 'bg-electric text-white'
                    : 'bg-white text-navy/60 hover:bg-slate-50'
                }`}
              >
                %
              </button>
            </div>
            <AmountInput
              id="inv-discount"
              placeholder={discountType === 'percent' ? '0' : '0.00'}
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
            />
          </div>
          {discountType === 'percent' && discount && (
            <p className="mt-1 text-xs text-navy/50">
              = {formatCurrency((totals.subtotal * ((parseFloat(discount) || 0) / 100)).toFixed(2))} off
            </p>
          )}
        </div>

        {/* Foreign currency (optional) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="inv-currency">Currency (optional)</Label>
            <Input
              id="inv-currency"
              placeholder="e.g. EUR"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <Label htmlFor="inv-fx">Exchange Rate</Label>
            <Input
              id="inv-fx"
              placeholder="1.00"
              type="number"
              min="0.0001"
              step="any"
              value={exchangeRate}
              disabled={!currency}
              onChange={(e) => setExchangeRate(e.target.value)}
            />
          </div>
        </div>

        {/* Live totals (incl. tax) */}
        <div className="rounded-lg bg-navy/5 px-4 py-3 space-y-1">
          <div className="flex items-center justify-between text-sm text-navy/60">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatCurrency(totals.subtotal.toFixed(2), currency || 'USD')}</span>
          </div>
          {totals.discount > 0 && (
            <div className="flex items-center justify-between text-sm text-navy/60">
              <span>Discount</span>
              <span className="tabular-nums">-{formatCurrency(totals.discount.toFixed(2), currency || 'USD')}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-sm text-navy/60">
            <span>Sales Tax{selectedRate ? ` (${(parseFloat(selectedRate.rate) * 100).toFixed(2)}%)` : ''}</span>
            <span className="tabular-nums">{formatCurrency(totals.tax.toFixed(2), currency || 'USD')}</span>
          </div>
          <div className="flex items-center justify-between border-t border-navy/10 pt-1">
            <span className="text-sm font-semibold text-navy/70">
              Total{currency ? ` (${currency})` : ''}
            </span>
            <span className="text-lg font-bold text-navy tabular-nums">
              {formatCurrency(totals.total.toFixed(2), currency || 'USD')}
            </span>
          </div>
          {totals.payments > 0 && (
            <>
              <div className="flex items-center justify-between text-sm text-navy/60">
                <span>Less payments received</span>
                <span className="tabular-nums">
                  -{formatCurrency(totals.payments.toFixed(2), currency || 'USD')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-navy/70">Balance Due</span>
                <span className="text-base font-bold text-navy tabular-nums">
                  {formatCurrency(totals.balanceDue.toFixed(2), currency || 'USD')}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function InvoicesPageContent() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | InvoiceStatus>('all');

  // Edit state — the full invoice (with lines) being edited.
  const [editTarget, setEditTarget] = useState<InvoiceDetail | null>(null);
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);

  // Void state
  const [voidTarget, setVoidTarget] = useState<Invoice | null>(null);
  const [voiding, setVoiding] = useState(false);

  // Post (pending → posted) state
  const [postTarget, setPostTarget] = useState<Invoice | null>(null);
  const [posting, setPosting] = useState(false);

  // Email state
  const [emailConfigured, setEmailConfigured] = useState(true);
  const [emailTarget, setEmailTarget] = useState<Invoice | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailing, setEmailing] = useState(false);

  const customerMap = Object.fromEntries(customers.map((c) => [c.id, c.displayName]));

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [invList, custList, emailStatus, itemList, rateList, classList, jobList] =
        await Promise.all([
          api.get<Invoice[]>('/api/invoices'),
          api.get<Customer[]>('/api/customers'),
          api.get<{ configured: boolean }>('/api/email/status'),
          api.get<{ items: Item[] }>('/api/items'),
          api.get<TaxRate[]>('/api/tax-rates'),
          api.get<ClassRow[]>('/api/classes'),
          api.get<Job[]>('/api/jobs'),
        ]);
      setInvoices(invList);
      setCustomers(custList);
      setEmailConfigured(emailStatus.configured);
      setItems(itemList.items ?? []);
      setTaxRates(rateList);
      setClasses(classList);
      setJobs(jobList);
    } catch (err: unknown) {
      toastError(err, 'Failed to load invoices.');
    } finally {
      setLoading(false);
    }
    // Custom field definitions are optional — never block the page on them.
    try {
      const res = await api.get<{ fields: CustomFieldDef[] }>('/api/invoices/custom-fields');
      setCustomFieldDefs(res.fields ?? []);
    } catch {
      setCustomFieldDefs([]);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Ctrl+I / Quick Actions navigate here with ?new=1 — open the create modal.
  useNewParam(() => {
    setEditTarget(null);
    setShowNew(true);
  });

  // Scroll to + highlight the row when arriving via global search (?focus=<id>)
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useFocusParam(invoices, loading, (inv) => {
    setFocusedId(inv.id);
    document
      .getElementById(`invoice-row-${inv.id}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  async function handleEdit(inv: Invoice) {
    setLoadingEditId(inv.id);
    try {
      const detail = await api.get<InvoiceDetail>(`/api/invoices/${inv.id}`);
      setEditTarget(detail);
    } catch (err: unknown) {
      toastError(err, 'Failed to load invoice.');
    } finally {
      setLoadingEditId(null);
    }
  }

  async function handleVoid() {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      await api.del(`/api/invoices/${voidTarget.id}`);
      toast(`Invoice #${voidTarget.invoiceNumber} voided.`, 'success');
      setVoidTarget(null);
      fetchData();
    } catch (err: unknown) {
      toastError(err, 'Failed to void invoice.');
    } finally {
      setVoiding(false);
    }
  }

  async function handlePost() {
    if (!postTarget) return;
    setPosting(true);
    try {
      await api.post(`/api/invoices/${postTarget.id}/post`, {});
      toast(`Invoice #${postTarget.invoiceNumber} posted to the GL.`, 'success');
      setPostTarget(null);
      fetchData();
    } catch (err: unknown) {
      toastError(err, 'Failed to post invoice.');
    } finally {
      setPosting(false);
    }
  }

  async function handleEmail() {
    if (!emailTarget) return;
    setEmailing(true);
    try {
      await api.post(`/api/invoices/${emailTarget.id}/email`, emailTo ? { to: emailTo } : {});
      toast(`Invoice #${emailTarget.invoiceNumber} emailed successfully.`, 'success');
      setEmailTarget(null);
      setEmailTo('');
    } catch (err: unknown) {
      toastError(err, 'Failed to send email.');
    } finally {
      setEmailing(false);
    }
  }

  const visibleInvoices =
    statusFilter === 'all' ? invoices : invoices.filter((i) => i.status === statusFilter);
  const pendingCount = invoices.filter((i) => i.status === 'draft').length;

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Invoices"
        icon={FileText}
        action={
          <div className="flex items-center gap-2">
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | InvoiceStatus)}
              aria-label="Filter by status"
              className="w-36"
            >
              <option value="all">All statuses</option>
              <option value="draft">Pending{pendingCount > 0 ? ` (${pendingCount})` : ''}</option>
              <option value="open">Open</option>
              <option value="partial">Partial</option>
              <option value="paid">Paid</option>
              <option value="void">Void</option>
            </Select>
            <Button onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" /> New Invoice
            </Button>
          </div>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : visibleInvoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={statusFilter === 'all' ? 'No invoices yet' : `No ${statusLabel(statusFilter as InvoiceStatus).toLowerCase()} invoices`}
            message={
              statusFilter === 'all'
                ? 'An invoice bills a customer who will pay you later. Create one, then use Receive Payments when the money arrives.'
                : 'Try a different status filter.'
            }
            action={
              statusFilter === 'all' ? (
                <Button onClick={() => setShowNew(true)}>
                  <Plus className="h-4 w-4" /> New Invoice
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Invoice #</Th>
                <Th>Customer</Th>
                <Th>Date</Th>
                <Th>Due Date</Th>
                <Th numeric>Total</Th>
                <Th numeric>Balance Due</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {visibleInvoices.map((inv) => {
                const overdue =
                  (inv.status === 'open' || inv.status === 'partial') &&
                  !!inv.dueDate &&
                  new Date(inv.dueDate) < new Date();
                return (
                <Tr
                  key={inv.id}
                  id={`invoice-row-${inv.id}`}
                  className={inv.id === focusedId ? 'bg-electric/10' : undefined}
                >
                  <Td className="font-semibold text-navy">#{inv.invoiceNumber}</Td>
                  <Td>{customerMap[inv.customerId] ?? '—'}</Td>
                  <Td className="text-navy/70">{formatDate(inv.date)}</Td>
                  <Td className="text-navy/70">{formatDate(inv.dueDate)}</Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(inv.total)}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(inv.balanceDue)}
                  </Td>
                  <Td>
                    <Badge tone={inv.status === 'draft' ? 'warning' : overdue ? 'overdue' : inv.status}>
                      {overdue ? 'Overdue' : statusLabel(inv.status)}
                    </Badge>
                  </Td>
                  <Td className="text-right">
                    <span className="inline-flex items-center gap-1">
                      {inv.status === 'draft' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPostTarget(inv)}
                          className="text-emerald hover:bg-emerald/10"
                          title="Post this pending invoice to the GL"
                        >
                          <Send className="h-3.5 w-3.5" /> Post
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.open(`/api/invoices/${inv.id}/pdf`, '_blank')}
                        title="View PDF"
                      >
                        <Download className="h-3.5 w-3.5" /> PDF
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.open(`/api/invoices/${inv.id}/packing-slip`, '_blank')}
                        title="View packing slip (quantities only, no prices)"
                      >
                        <Package className="h-3.5 w-3.5" /> Packing Slip
                      </Button>
                      {(inv.status === 'open' || inv.status === 'draft') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(inv)}
                          loading={loadingEditId === inv.id}
                          title={
                            inv.status === 'draft'
                              ? 'Edit pending invoice (nothing posted yet)'
                              : 'Edit invoice (re-posts the GL entry)'
                          }
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                      )}
                      {inv.status !== 'void' && inv.status !== 'draft' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setEmailTarget(inv); setEmailTo(''); }}
                          title={emailConfigured ? 'Email invoice' : 'Email not configured'}
                        >
                          <Mail className="h-3.5 w-3.5" /> Email
                        </Button>
                      )}
                      {inv.status !== 'void' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setVoidTarget(inv)}
                          className="text-red-500 hover:bg-red-50"
                          title={inv.status === 'draft' ? 'Discard pending invoice' : 'Void invoice'}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> {inv.status === 'draft' ? 'Discard' : 'Void'}
                        </Button>
                      )}
                    </span>
                  </Td>
                </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Summary footer */}
      {invoices.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}
          </span>
          <span>
            Open:{' '}
            <span className="font-semibold text-navy/70">
              {invoices.filter((i) => i.status === 'open' || i.status === 'partial').length}
            </span>
          </span>
          {pendingCount > 0 && (
            <span>
              Pending:{' '}
              <span className="font-semibold text-navy/70">{pendingCount}</span>
            </span>
          )}
          <span>
            Total outstanding:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(
                invoices
                  .filter((i) => i.status !== 'void' && i.status !== 'draft')
                  .reduce((s, i) => s + Number(i.balanceDue), 0)
                  .toFixed(2),
              )}
            </span>
          </span>
        </div>
      )}

      <InvoiceModal
        open={showNew || !!editTarget}
        editing={editTarget}
        onClose={() => { setShowNew(false); setEditTarget(null); }}
        customers={customers}
        items={items}
        taxRates={taxRates}
        classes={classes}
        jobs={jobs}
        customFieldDefs={customFieldDefs}
        onSaved={fetchData}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title={voidTarget?.status === 'draft' ? 'Discard Pending Invoice' : 'Void Invoice'}
        message={
          voidTarget?.status === 'draft' ? (
            <>
              Discard pending <strong>Invoice #{voidTarget?.invoiceNumber}</strong>? Nothing was
              posted to the GL, so this just marks the draft void.
            </>
          ) : (
            <>
              Are you sure you want to void{' '}
              <strong>Invoice #{voidTarget?.invoiceNumber}</strong>? This will reverse the GL
              entry and cannot be undone.
            </>
          )
        }
        confirmLabel={voidTarget?.status === 'draft' ? 'Discard' : 'Void Invoice'}
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />

      <ConfirmDialog
        open={!!postTarget}
        title="Post Pending Invoice"
        message={
          <>
            Post <strong>Invoice #{postTarget?.invoiceNumber}</strong> to the general ledger? This
            records A/R and income (and relieves inventory) as of the invoice date. The fiscal
            period is checked now.
          </>
        }
        confirmLabel="Post Invoice"
        loading={posting}
        onConfirm={handlePost}
        onClose={() => setPostTarget(null)}
      />

      {/* Email Invoice Modal */}
      <Modal
        open={!!emailTarget}
        onClose={() => { setEmailTarget(null); setEmailTo(''); }}
        title={`Email Invoice #${emailTarget?.invoiceNumber ?? ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setEmailTarget(null); setEmailTo(''); }} disabled={emailing}>
              Cancel
            </Button>
            <Button onClick={handleEmail} loading={emailing} disabled={!emailConfigured}>
              Send Email
            </Button>
          </>
        }
      >
        {!emailConfigured && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            <strong>SMTP not configured.</strong> Set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>,{' '}
            <code>SMTP_USER</code>, <code>SMTP_PASS</code>, and <code>SMTP_FROM</code> environment
            variables to enable email sending.
          </div>
        )}
        <div>
          <Label htmlFor="email-to">Recipient Email</Label>
          <Input
            id="email-to"
            type="email"
            placeholder="Leave blank to use customer email on file"
            value={emailTo}
            onChange={(e) => setEmailTo(e.target.value)}
            disabled={emailing}
            autoFocus
          />
          <p className="mt-1 text-xs text-navy/50">
            The invoice PDF will be attached to the email.
          </p>
        </div>
      </Modal>
    </main>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense fallback={null}>
      <InvoicesPageContent />
    </Suspense>
  );
}
