'use client';

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
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
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { useFocusParam, useNewParam } from '@/lib/useFocusParam';
import {
  BarcodeScanInput,
  InventoryLineFields,
  type InvDetail,
  type ScannedItem,
  invFromLine,
  inventoryLinePayload,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';
import { usePriceQuotes, samePrice } from '@/lib/usePriceQuotes';
import { PriceSourceBadge } from '@/components/PriceSourceBadge';
import Link from 'next/link';
import {
  EMPTY_SHIPPING,
  ShippingSection,
  type ShippingState,
  shippingFromDoc,
  shippingPayload,
  useCreditLimitConfirm,
  useCustomerSalesDefaults,
  defaultShipToState,
} from '@/components/sales/SalesExtras';
import { useDocNumber } from '@/components/sales/DocNumberField';
// wave2 prefs: Preferences-driven defaults/warnings, memorize (Ctrl+M), attachments
import { usePreferences } from '@/lib/usePreferences';
import { confirmClassAssigned, confirmStockAvailable, confirmTransactionDate } from '@/lib/formPrefs';
import { fetchDueDateForTerms, useTermsChoices, withCurrentTerms } from '@/lib/termsClient';
import MemorizeButton from '@/components/MemorizeButton';
import AttachmentPanel from '@/components/AttachmentPanel';
import { recallNote, useSmartDefaults } from '@/lib/useSmartDefaults';
import type { SmartLine } from '@/lib/smartDefaults';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
  terms?: string | null;
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
  trackingMode?: string | null;
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
  /** Alphanumeric number shown to users (e.g. "INV-1001"); null on very old rows. */
  refNumber?: string | null;
  customerId: string;
  date: string;
  dueDate: string | null;
  /** Payment terms (Terms list code/name) the due date was worked out from. */
  terms?: string | null;
  total: string;
  balanceDue: string;
  status: InvoiceStatus;
  /** wave2 sales: a customer-register statement charge (C5). */
  isStatementCharge?: boolean;
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
}

/** Full invoice (GET /api/invoices/:id) used to prefill the edit modal. */
interface InvoiceDetail extends Invoice {
  taxRateId: string | null;
  classId: string | null;
  salesRepId?: string | null;
  discount: string;
  discountType: 'amount' | 'percent' | null;
  /** Retainage held back (contractors): percent of the total and the held amount. */
  retainagePercent?: string | null;
  retainageAmount?: string | null;
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
    /** Progress invoicing: the estimate line this invoice line bills. */
    estimateLineId?: string | null;
    itemName: string | null;
    itemType: ItemType | null;
    unitOfMeasure: string | null;
    // Advanced Inventory detail (present only when stored for the line)
    siteId?: string | null;
    binId?: string | null;
    serialNumbers?: string[] | null;
    lotNumber?: string | null;
    lotExpiration?: string | null;
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
  /** Advanced Inventory: site / bin / serials / lot the stock is sold from. */
  inv?: InvDetail;
  /** Advanced pricing: the user typed this rate, so automatic prices must not replace it. */
  rateManual?: boolean;
  /** Progress invoicing: the estimate line this row bills (kept through an edit; cleared
   *  when the row's item changes). */
  estimateLineId?: string | null;
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

/** A recalled line (smart defaults: the customer's last invoice) as a form row. */
function rowFromRecall(l: SmartLine, items: Item[]): LineRow {
  const item = l.itemId ? items.find((it) => it.id === l.itemId) : undefined;
  return {
    ...EMPTY_LINE,
    itemName: item?.name ?? '',
    itemId: item ? item.id : null,
    itemType: item?.type ?? null,
    unitOfMeasure: item?.unitOfMeasure ?? null,
    description: l.description ?? '',
    quantity: l.quantity ? String(Number(l.quantity)) : '1',
    rate: l.rate ? String(Number(l.rate)) : '',
    taxable: l.taxable ?? true,
    jobId: l.jobId ?? '',
    // QB recall keeps last time's rates: automatic pricing must not replace them.
    rateManual: true,
  };
}

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
  const [terms, setTerms] = useState('');
  // Terms list entries (custom and date-driven terms included).
  const termsChoices = useTermsChoices();
  const [taxRateId, setTaxRateId] = useState('');
  const [classId, setClassId] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  const [salesReps, setSalesReps] = useState<Array<{ id: string; name: string; isActive?: boolean }>>([]);
  /** Smart defaults: what was recalled from the customer's last invoice (shown under Customer). */
  const [recallText, setRecallText] = useState('');
  /** Tax item recalled from the last invoice — wins over the customer's default tax item. */
  const recalledTaxRef = useRef<string | null>(null);
  /** Current terms (so a late due-date lookup for replaced terms is ignored). */
  const termsRef = useRef('');
  const [discount, setDiscount] = useState('');
  const [discountType, setDiscountType] = useState<DiscountType>('amount');
  const [currency, setCurrency] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [memo, setMemo] = useState('');
  const [ship, setShip] = useState<ShippingState>(EMPTY_SHIPPING);
  const creditLimit = useCreditLimitConfirm();
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
  // Invoice # (pre-filled with the next number, editable; a duplicate asks to confirm).
  const invNumber = useDocNumber('invoice', open, editing ? (editing.refNumber || String(editing.invoiceNumber)) : null);
  const refNumber = invNumber.value;
  const setRefNumber = invNumber.setValue;
  const [dupNumberPrompt, setDupNumberPrompt] = useState<string | null>(null);
  // Retainage (contractors): % of the total held back in Retainage Receivable until billed.
  const [retainagePercent, setRetainagePercent] = useState('');
  // Customer defaults (new invoices): tax item / non-taxable tax code and default ship-to.
  const custDefaults = useCustomerSalesDefaults(open ? customerId : null);
  useEffect(() => {
    if (!custDefaults || editing) return;
    setTaxRateId(custDefaults.taxable ? (recalledTaxRef.current ?? custDefaults.taxRateId ?? '') : '');
    const st = defaultShipToState(custDefaults);
    if (st) setShip((prev) => ({ ...prev, shipTo: st }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custDefaults]);

  const itemNameById = new Map(items.map((it) => [it.id, it.name]));
  const prefs = usePreferences();
  // Smart defaults (lib/useSmartDefaults.ts): default date + recall the customer's last invoice.
  const smart = useSmartDefaults('invoice');
  termsRef.current = terms;

  // Sales reps for the Rep field (list permission may be missing: then the field just hides).
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .get<Array<{ id: string; name: string; isActive?: boolean }>>('/api/sales-reps')
      .then((r) => live && setSalesReps(Array.isArray(r) ? r : []))
      .catch(() => live && setSalesReps([]));
    return () => {
      live = false;
    };
  }, [open]);

  // Reset / prefill form when the modal opens.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCustomerId(editing.customerId);
      setDate(editing.date ? editing.date.slice(0, 10) : new Date().toISOString().slice(0, 10));
      setDueDate(editing.dueDate ? editing.dueDate.slice(0, 10) : '');
      setTerms(editing.terms ?? '');
      setTaxRateId(editing.taxRateId ?? '');
      setClassId(editing.classId ?? '');
      setSalesRepId(editing.salesRepId ?? '');
      // The stored discount is the resolved dollar amount — prefill as a flat amount.
      setDiscount(Number(editing.discount) > 0 ? editing.discount : '');
      setDiscountType('amount');
      setCurrency(editing.currency ?? '');
      setExchangeRate(
        editing.currency && editing.exchangeRate ? String(Number(editing.exchangeRate)) : '',
      );
      setMemo(editing.memo ?? '');
      setShip(shippingFromDoc(editing));
      setRetainagePercent(
        editing.retainagePercent && Number(editing.retainagePercent) > 0 ? String(Number(editing.retainagePercent)) : '',
      );
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
          inv: invFromLine(l),
          // Saved invoices keep their stored rates; the badge still flags rule differences.
          rateManual: true,
          estimateLineId: l.estimateLineId ?? null,
        })),
      );
    } else {
      setCustomerId('');
      // My Preferences > General "Default date": today, or the last invoice date entered this session.
      setDate(smart.defaultDate());
      setDueDate('');
      setTerms('');
      setTaxRateId('');
      setClassId('');
      setSalesRepId('');
      setDiscount('');
      setDiscountType('amount');
      setCurrency('');
      setExchangeRate('');
      // Preferences > Sales & Customers: default customer message.
      setMemo(prefs.company.defaultInvoiceMemo ?? '');
      setShip(shippingFromDoc(null));
      setSaveAsPending(false);
      setRetainagePercent('');
      setCustomValues({});
      setLines([{ ...EMPTY_LINE }]);
    }
    setRecallText('');
    recalledTaxRef.current = null;
    setBillables(null);
    setSelectedCostIds(new Set());
    setSelectedTimeIds(new Set());
    // Preferences > Time & Expenses: default markup on billable costs.
    setMarkupPercent(prefs.company.defaultMarkupPercent > 0 ? String(prefs.company.defaultMarkupPercent) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // New invoice: due date follows the customer's terms (else the default terms preference).
  useEffect(() => {
    if (!open || editing || !customerId || !date) return;
    const cust = customers.find((c) => c.id === customerId);
    const custTerms = cust?.terms || prefs.company.defaultCustomerTerms;
    setTerms(custTerms ?? '');
    // Terms list entries (Standard or Date-Driven) via /api/terms/compute.
    let live = true;
    void fetchDueDateForTerms(date, custTerms).then((due) => {
      if (live && due && termsRef.current === (custTerms ?? '')) setDueDate(due);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, customerId]);

  // QB "Recall the last transaction for a name" (My Preferences > General): a NEW invoice for
  // this customer starts from their last one — items, rates, terms, sales rep, class, tax item
  // and memo. Never replaces lines the user already typed.
  const { recall } = smart;
  useEffect(() => {
    setRecallText('');
    recalledTaxRef.current = null;
    if (!open || editing || !customerId) return;
    let live = true;
    void recall(customerId).then((d) => {
      if (!live || !d) return;
      const h = d.header;
      if (h.terms) {
        const t = h.terms;
        setTerms(t);
        termsRef.current = t;
        if (date) {
          void fetchDueDateForTerms(date, t).then((due) => {
            if (live && due && termsRef.current === t) setDueDate(due);
          });
        }
      }
      if (h.salesRepId) setSalesRepId(h.salesRepId);
      if (h.classId) setClassId(h.classId);
      if (h.taxRateId) {
        recalledTaxRef.current = h.taxRateId;
        setTaxRateId(h.taxRateId);
      }
      if (h.memo) {
        const m = h.memo;
        setMemo((prev) => (!prev.trim() || prev === (prefs.company.defaultInvoiceMemo ?? '') ? m : prev));
      }
      if (d.lines.length > 0) {
        setLines((prev) =>
          prev.every((l) => !l.itemId && !l.itemName.trim() && !l.description.trim() && !l.rate)
            ? d.lines.map((l) => rowFromRecall(l, items))
            : prev,
        );
      }
      setRecallText(recallNote(d));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, customerId, recall]);

  /** Terms picked on the form: the due date follows them. */
  function handleTermsChange(value: string) {
    setTerms(value);
    if (!value || !date) return;
    void fetchDueDateForTerms(date, value).then((due) => {
      if (due) setDueDate(due);
    });
  }

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
      const row = { ...next[idx], ...patch };
      // A row switched to a different item no longer bills its estimate line.
      if ('itemId' in patch && patch.itemId !== next[idx].itemId) row.estimateLineId = null;
      next[idx] = row;
      return next;
    });
  }

  // Advanced pricing: server-side price rules / price levels / customer prices per line.
  const quotes = usePriceQuotes(
    { customerId, date, classId: classId || null },
    lines.map((l) => ({ itemId: lineKind(l) === 'income' ? l.itemId : null, quantity: l.quantity || '1' })),
  );
  useEffect(() => {
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l, i) => {
        const qt = quotes[i];
        if (!qt || l.rateManual || l.itemId !== qt.itemId || samePrice(l.rate, qt.price)) return l;
        changed = true;
        return { ...l, rate: String(Number(qt.price)) };
      });
      return changed ? next : prev;
    });
  }, [quotes]);

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
        rateManual: false,
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

  // Advanced Inventory: sites/bins for item lines + scan-to-add (fills an empty line or
  // appends one, then runs the normal item lookup so prices/bundles behave as if typed).
  const adv = useAdvancedInventory(open);
  const [pendingScanIdx, setPendingScanIdx] = useState<number | null>(null);
  function addScannedItem(it: ScannedItem) {
    const emptyIdx = lines.findIndex((l) => !l.itemId && !l.itemName && !l.description && !l.quantity && !l.rate);
    if (emptyIdx >= 0) {
      handleItemInput(emptyIdx, it.name);
      return;
    }
    setLines((prev) => [...prev, { ...EMPTY_LINE, itemName: it.name }]);
    setPendingScanIdx(lines.length);
  }
  useEffect(() => {
    if (pendingScanIdx == null || !lines[pendingScanIdx]) return;
    const name = lines[pendingScanIdx].itemName;
    setPendingScanIdx(null);
    handleItemInput(pendingScanIdx, name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScanIdx, lines]);

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

  // Held-back retainage shown on the form (the server computes the same: total × %).
  const retainageHeld = (() => {
    const pct = parseFloat(retainagePercent);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    return Math.round(totals.total * Math.min(pct, 100)) / 100;
  })();

  async function handleSubmit(allowDuplicateNumber = false) {
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
      terms: terms || undefined,
      taxRateId: taxRateId || undefined,
      classId: classId || undefined,
      salesRepId: salesRepId || (editing ? null : undefined),
      discount: discount || undefined,
      discountType,
      currency: currency || undefined,
      exchangeRate: exchangeRate || undefined,
      retainagePercent: retainagePercent.trim() ? retainagePercent.trim() : null,
      memo: memo || undefined,
      customFields: customFieldDefs.length > 0 ? customValues : undefined,
      ...shippingPayload(ship),
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
            ...(editing ? { estimateLineId: l.estimateLineId ?? null } : {}),
          };
        }
        return {
          itemId: l.itemId,
          description: l.description || null,
          quantity: l.quantity,
          rate: l.rate,
          taxable: l.taxable,
          jobId: l.jobId || null,
          ...inventoryLinePayload(l.inv),
          // Edits send each row's estimate link back so progress billing stays on the right line.
          ...(editing ? { estimateLineId: l.estimateLineId ?? null } : {}),
        };
      }),
    };

    if (!editing) payload.status = saveAsPending ? 'draft' : 'open';
    // Invoice # on new AND edited invoices (QB lets you retype it; a duplicate asks first).
    if (refNumber.trim()) payload.refNumber = refNumber.trim();
    if (allowDuplicateNumber) payload.allowDuplicateNumber = true;
    const retPct = parseFloat(retainagePercent);
    if (retainagePercent.trim() && (!Number.isFinite(retPct) || retPct < 0 || retPct > 100)) {
      toast('Retainage must be a percent between 0 and 100.', 'danger');
      return;
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

    // Preferences: date range, class, and not-enough-inventory warnings.
    if (!confirmTransactionDate(date, prefs)) return;
    if (!confirmClassAssigned(classId, prefs)) return;
    if (
      !confirmStockAvailable(
        indexed.map(({ l }) => ({ itemId: l.itemId, quantity: l.quantity })),
        items,
        prefs,
        editing?.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) ?? [],
      )
    ) {
      return;
    }

    setSaving(true);
    try {
      // Over the customer's credit limit → "Save anyway?" (recorded in the audit trail).
      const saved = await creditLimit.run((override, allowOverBilling) =>
        editing
          ? api.patch(`/api/invoices/${editing.id}`, { ...payload, overrideCreditLimit: override, allowOverBilling })
          : api.post('/api/invoices', { ...payload, overrideCreditLimit: override, allowOverBilling }),
      );
      if (saved === undefined) return; // user chose not to go over the limit
      if (!editing) smart.rememberDate(date);
      if (editing) {
        toast(`Invoice #${refNumber.trim() || editing.refNumber || editing.invoiceNumber} updated.`, 'success');
      } else {
        toast(saveAsPending ? 'Pending invoice saved (not posted).' : 'Invoice created.', 'success');
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409 && /number .* is already used/i.test(err.message)) {
        setDupNumberPrompt(err.message);
        return;
      }
      toastError(err, 'Failed to save invoice.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Modal
      size="lg"
      open={open}
      onClose={onClose}
      title={
        editing
          ? `Edit Invoice #${editing.refNumber || editing.invoiceNumber}${editing.status === 'draft' ? ' (Pending)' : ''}`
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
          <MemorizeButton
            docType="invoice"
            shortcut={open}
            defaultName={customers.find((c) => c.id === customerId)?.displayName}
            getTemplate={() => {
              if (!customerId) return 'Pick a customer before memorizing.';
              const rows = lines.filter((l) => (l.itemId || l.description) && lineKind(l) !== 'subtotal');
              if (rows.length === 0) return 'Add at least one line before memorizing.';
              return {
                customerId,
                date,
                dueDate: dueDate || undefined,
                taxRateId: taxRateId || undefined,
                classId: classId || undefined,
                memo: memo || undefined,
                lines: rows.map((l) => ({
                  itemId: l.itemId,
                  description: l.description || null,
                  quantity: l.quantity || '1',
                  rate: l.rate || '0',
                  taxable: l.taxable,
                  jobId: l.jobId || null,
                })),
              };
            }}
          />
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => handleSubmit()} loading={saving}>
            {editing ? 'Save Changes' : saveAsPending ? 'Save Pending' : 'Create Invoice'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editing && editing.status !== 'draft' && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Saving changes re-posts this invoice (and any cost of goods) so your books stay
            balanced. Payments already received stay applied, so the new amount due can&apos;t be
            less than what has been paid. The date must be after your closing date.
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
          {recallText && <p className="mt-1 text-xs text-electric" role="status">{recallText}</p>}
        </div>

        {/* Invoice number (QB "Invoice #"): pre-filled with the next number, letters allowed */}
        <div>
          <Label htmlFor="inv-number">Invoice #</Label>
          <Input
            id="inv-number"
            value={refNumber}
            maxLength={50}
            placeholder="Leave blank for the next number"
            onChange={(e) => setRefNumber(e.target.value)}
          />
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

        {/* Terms (Terms list: Standard or Date-Driven) — picking one fills the due date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="inv-terms">Terms</Label>
            <Select id="inv-terms" value={terms} onChange={(e) => handleTermsChange(e.target.value)}>
              <option value="">—</option>
              {withCurrentTerms(termsChoices, terms).map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          {/* Sales rep (Lists > Sales Rep): shown once the company has reps; a saved rep still shows. */}
          {(salesReps.length > 0 || salesRepId) && (
            <div>
              <Label htmlFor="inv-rep">Sales rep (optional)</Label>
              <Select id="inv-rep" value={salesRepId} onChange={(e) => setSalesRepId(e.target.value)}>
                <option value="">No rep</option>
                {salesReps
                  .filter((r) => r.isActive !== false || r.id === salesRepId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </Select>
            </div>
          )}
        </div>

        {/* Tax rate + class */}
        <div className="grid grid-cols-2 gap-3">
          {/* Hidden while "Charge sales tax" is off (QB removes tax from forms); an old document keeps its tax. */}
          {(prefs.company.salesTaxEnabled || taxRateId) ? (<div>
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
          </div>) : <div />}
          {/* Class fields are hidden while "Use class tracking" is off (QB); a saved class still shows. */}
          {(prefs.company.classTrackingEnabled || classId) && (<div>
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
          </div>)}
        </div>

        {/* Shipping + print/email queue (wave2 sales) */}
        <ShippingSection value={ship} onChange={setShip} shipTos={custDefaults?.shipTos} idPrefix="inv-ship" />
        {creditLimit.dialog}

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
            <div className="flex items-center gap-3">
              <BarcodeScanInput onItem={addScannedItem} />
              <button
                type="button"
                onClick={addLine}
                className="text-electric hover:text-electric/80 flex items-center gap-1 text-sm font-medium"
              >
                <PlusCircle className="h-4 w-4" /> Add line
              </button>
            </div>
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
                    onChange={(e) => updateLine(idx, { rate: e.target.value, rateManual: true })}
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
                {/* Advanced Inventory: site / bin / serial / lot for inventory items */}
                {kind === 'income' && line.itemId && (
                  <InventoryLineFields
                    adv={adv}
                    item={items.find((it) => it.id === line.itemId)}
                    quantity={line.quantity}
                    direction="out"
                    value={line.inv}
                    onChange={(inv) => updateLine(idx, { inv })}
                  />
                )}
                {kind === 'income' && (
                  <PriceSourceBadge
                    quote={quotes[idx]}
                    rate={line.rate}
                    onUseQuoted={(price) => updateLine(idx, { rate: String(Number(price)), rateManual: false })}
                  />
                )}
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

        {/* Retainage (contractors): part of the total held back until the work is accepted */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="inv-retainage">
              Retainage % <span className="font-normal text-navy/50">(optional)</span>
            </Label>
            <Input
              id="inv-retainage"
              type="number"
              min="0"
              max="100"
              step="any"
              placeholder="e.g. 10"
              value={retainagePercent}
              onChange={(e) => setRetainagePercent(e.target.value)}
            />
          </div>
          <p className="self-end pb-2 text-xs text-navy/50">
            The held amount isn&apos;t due yet. Bill it later from{' '}
            <Link href="/invoices/retainage" className="text-electric hover:underline">Retainage</Link>.
          </p>
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
          {retainageHeld > 0 && (
            <>
              <div className="flex items-center justify-between text-sm text-navy/60">
                <span>Retainage held ({Number(retainagePercent)}%)</span>
                <span className="tabular-nums">
                  -{formatCurrency(retainageHeld.toFixed(2), currency || 'USD')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-navy/70">Due now</span>
                <span className="text-base font-bold text-navy tabular-nums">
                  {formatCurrency((totals.total - retainageHeld - totals.payments).toFixed(2), currency || 'USD')}
                </span>
              </div>
            </>
          )}
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
      {open && (
        <AttachmentPanel className="mt-4" entityType="invoice" entityId={editing?.id} />
      )}
    </Modal>
    <ConfirmDialog
      open={dupNumberPrompt !== null}
      title="Number already used"
      message={dupNumberPrompt ?? undefined}
      confirmLabel="Keep this number"
      onClose={() => setDupNumberPrompt(null)}
      onConfirm={() => {
        setDupNumberPrompt(null);
        void handleSubmit(true);
      }}
    />
    </>
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
  const postLimit = useCreditLimitConfirm();
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
      toast(`Invoice #${voidTarget.refNumber || voidTarget.invoiceNumber} voided.`, 'success');
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
      const posted = await postLimit.run((override, allowOverBilling) =>
        api.post(`/api/invoices/${postTarget.id}/post`, { overrideCreditLimit: override, allowOverBilling }),
      );
      if (posted === undefined) return;
      toast(`Invoice #${postTarget.refNumber || postTarget.invoiceNumber} posted to the GL.`, 'success');
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
      toast(`Invoice #${emailTarget.refNumber || emailTarget.invoiceNumber} emailed successfully.`, 'success');
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
            <Link href="/invoices/batch" className="text-sm font-semibold text-electric hover:underline px-2">
              Batch invoicing
            </Link>
            <Link href="/invoices/statement-charges" className="text-sm font-semibold text-electric hover:underline px-2">
              Statement charges
            </Link>
            <Link href="/invoices/retainage" className="text-sm font-semibold text-electric hover:underline px-2">
              Retainage
            </Link>
            <Link href="/invoices/send-forms" className="text-sm font-semibold text-electric hover:underline px-2">
              Print / send forms
            </Link>
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
                  <Td className="font-semibold text-navy">
                    #{inv.refNumber ?? inv.invoiceNumber}
                    {inv.isStatementCharge && (
                      <span className="ml-2 align-middle">
                        <Badge tone="neutral">Statement charge</Badge>
                      </span>
                    )}
                  </Td>
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
              Discard pending <strong>Invoice #{voidTarget?.refNumber || voidTarget?.invoiceNumber}</strong>? Nothing was
              posted to the GL, so this just marks the draft void.
            </>
          ) : (
            <>
              Are you sure you want to void{' '}
              <strong>Invoice #{voidTarget?.refNumber || voidTarget?.invoiceNumber}</strong>? This will reverse the GL
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
            Post <strong>Invoice #{postTarget?.refNumber || postTarget?.invoiceNumber}</strong> to the general ledger? This
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
        title={`Email Invoice #${emailTarget?.refNumber || emailTarget?.invoiceNumber || ''}`}
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
      {postLimit.dialog}
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
