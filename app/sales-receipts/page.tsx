'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Receipt, Plus, Trash2, PlusCircle, MinusCircle, Pencil } from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Input,
  Select,
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
  useGridKeys,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';
import {
  BarcodeScanInput,
  InventoryLineFields,
  type InvDetail,
  inventoryLinePayload,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';
import { formatDate } from '@/lib/format';
import { isDepositTargetAccount } from '@/lib/accountTypes';
import { usePriceQuotes, samePrice } from '@/lib/usePriceQuotes';
import { PriceSourceBadge } from '@/components/PriceSourceBadge';
import {
  EMPTY_SHIPPING,
  FormSendButtons,
  ShippingSection,
  type ShippingState,
  shippingFromDoc,
  shippingPayload,
  useCustomerSalesDefaults,
  defaultShipToState,
} from '@/components/sales/SalesExtras';
import {
  DocNumberField,
  docNo,
  useDocNumber,
  useDuplicateNumberConfirm,
} from '@/components/sales/DocNumberField';
// wave2 prefs: Payments > default deposit account; Memorize (Ctrl+M)
import { usePreferences } from '@/lib/usePreferences';
import MemorizeButton from '@/components/MemorizeButton';
import { recallNote, useSmartDefaults } from '@/lib/useSmartDefaults';
import { recallNumber, recallQuantity } from '@/lib/smartDefaults';
// cmdbar: forms accept a prefill from the Ctrl+K command bar.
import PrefillNotice from '@/components/PrefillNotice';
import { previewSalesTotals } from '@/lib/salesLineMath';
import { usePrefill } from '@/lib/commands/usePrefill';
import type { FormPrefill } from '@/lib/commands/prefill';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
}

interface Item {
  id: string;
  name: string;
  type: string;
  salesPrice: string | null;
  trackingMode?: string | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
}

interface TaxRate {
  id: string;
  name: string;
  rate: string;
}

interface SalesReceipt {
  id: string;
  receiptNumber: number;
  /** Sale No. the user typed / sees. */
  refNumber?: string | null;
  customerId: string | null;
  customerName: string | null;
  date: string;
  method: string;
  reference: string | null;
  subtotal: string;
  taxAmount: string;
  total: string;
  status: 'paid' | 'void' | string;
}

/** GET /api/sales-receipts/:id (used to prefill the edit form, wave2 sales C1). */
interface SalesReceiptDetail extends SalesReceipt {
  depositAccountId: string | null;
  taxRateId: string | null;
  classId?: string | null;
  memo: string | null;
  shipDate?: string | null;
  shipVia?: string | null;
  fob?: string | null;
  trackingNumber?: string | null;
  poNumber?: string | null;
  shipTo?: Record<string, string> | null;
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
  lines: Array<{
    itemId: string | null;
    description: string | null;
    quantity: string;
    rate: string;
    taxable: boolean;
  }>;
}

interface LineRow {
  itemId: string;
  description: string;
  quantity: string;
  rate: string;
  taxable: boolean;
  /** Advanced Inventory: site / bin / serials / lot the stock is sold from. */
  inv?: InvDetail;
  /** Advanced pricing: the user typed the rate (automatic prices leave it alone). */
  rateManual?: boolean;
}

const EMPTY_LINE: LineRow = { itemId: '', description: '', quantity: '', rate: '', taxable: true };

const METHODS: Array<{ value: string; label: string }> = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'ach', label: 'ACH' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'other', label: 'Other' },
];

function methodLabel(value: string): string {
  return METHODS.find((m) => m.value === value)?.label ?? value;
}

/** Same item-type math as the service: discount items subtract, subtotal items add nothing. */
function computeTotals(lines: LineRow[], taxRate: TaxRate | undefined, items: Item[]) {
  const { subtotal, tax, total } = previewSalesTotals(
    lines.map((l) => ({ ...l, itemType: items.find((i) => i.id === l.itemId)?.type ?? null })),
    taxRate ? parseFloat(taxRate.rate) || 0 : 0,
  );
  return { subtotal, tax, total };
}

// ---------------------------------------------------------------------------
// New Sales Receipt Modal
// ---------------------------------------------------------------------------

interface NewReceiptModalProps {
  open: boolean;
  /** wave2 sales (C1): receipt being edited (null = new). */
  editing?: SalesReceiptDetail | null;
  onClose: () => void;
  customers: Customer[];
  items: Item[];
  accounts: Account[];
  taxRates: TaxRate[];
  onCreated: () => void;
  /** cmdbar: values from the command bar for a NEW receipt (the user still reviews and saves). */
  prefill?: FormPrefill | null;
}

function NewReceiptModal({
  open,
  editing,
  onClose,
  customers,
  items,
  accounts,
  taxRates,
  onCreated,
  prefill = null,
}: NewReceiptModalProps) {
  // QB lists bank, Undeposited Funds and other current assets in "Deposit to" — never A/R.
  const depositAccounts = accounts.filter((a) => isDepositTargetAccount(a));
  const undepositedFunds = depositAccounts.find((a) => a.code === '1050');
  const prefs = usePreferences();
  // Preferences > Payments: Undeposited Funds, or the Checking default deposit account.
  const defaultDepositId = (() => {
    const def = prefs.company.defaultDepositAccountId;
    if (!prefs.company.useUndepositedFunds && def && depositAccounts.some((a) => a.id === def)) return def;
    return undepositedFunds?.id ?? '';
  })();

  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(() => todayISO());
  const [method, setMethod] = useState('cash');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [taxRateId, setTaxRateId] = useState('');
  const [classId, setClassId] = useState('');
  const [classes, setClasses] = useState<Array<{ id: string; name: string }>>([]);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([{ ...EMPTY_LINE }]);
  const [ship, setShip] = useState<ShippingState>(EMPTY_SHIPPING);
  // Smart defaults (lib/useSmartDefaults.ts): default date + recall the customer's last receipt.
  const smart = useSmartDefaults('sales_receipt');
  const [recallText, setRecallText] = useState('');
  /** Tax item recalled from the last receipt — wins over the customer's default tax item. */
  const recalledTaxRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const docNumber = useDocNumber('sales_receipt', open, editing ? docNo(editing.refNumber, editing.receiptNumber) : null);
  const dupConfirm = useDuplicateNumberConfirm();
  // Customer defaults (new receipts): tax item, non-taxable tax code, default ship-to.
  const custDefaults = useCustomerSalesDefaults(open ? customerId : null);
  useEffect(() => {
    if (!custDefaults || editing) return;
    setTaxRateId(custDefaults.taxable ? (recalledTaxRef.current ?? custDefaults.taxRateId ?? '') : '');
    const st = defaultShipToState(custDefaults);
    if (st) setShip((prev) => ({ ...prev, shipTo: st }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custDefaults]);

  // Reset form when modal opens; deposit-to defaults to Undeposited Funds (1050)
  // so receipts flow into the Make Deposits workflow.
  useEffect(() => {
    if (open && editing) {
      setCustomerId(editing.customerId ?? '');
      setDate(editing.date.slice(0, 10));
      setMethod(editing.method);
      setDepositAccountId(editing.depositAccountId ?? '');
      setReference(editing.reference ?? '');
      setTaxRateId(editing.taxRateId ?? '');
      setClassId(editing.classId ?? '');
      setMemo(editing.memo ?? '');
      setShip(shippingFromDoc(editing));
      setLines(
        editing.lines.map((l) => ({
          itemId: l.itemId ?? '',
          description: l.description ?? '',
          quantity: String(Number(l.quantity)),
          rate: String(Number(l.rate)),
          taxable: l.taxable,
          rateManual: true,
        })),
      );
      return;
    }
    if (open) {
      setShip(shippingFromDoc(null));
      setCustomerId('');
      // My Preferences > General "Default date": today, or the last receipt date entered this session.
      setDate(smart.defaultDate());
      setMethod('cash');
      setDepositAccountId(defaultDepositId);
      setReference('');
      setTaxRateId('');
      setClassId('');
      setMemo('');
      setLines([{ ...EMPTY_LINE }]);
      // cmdbar: a command-bar prefill ("sold 2 widgets to Acme").
      if (prefill) {
        setCustomerId(prefill.customerId ?? '');
        if (prefill.date) setDate(prefill.date);
        if (prefill.memo) setMemo(prefill.memo);
        if (prefill.lines.length) {
          setLines(
            prefill.lines.map((l) => ({
              ...EMPTY_LINE,
              itemId: l.itemId ?? '',
              description: l.description ?? '',
              quantity: l.quantity ?? '1',
              rate: l.rate ?? '',
              taxable: l.taxable ?? true,
              rateManual: !!l.rateFromUser,
            })),
          );
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, prefill]);

  // Classes for the Class field (shown while class tracking is on).
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .get<Array<{ id: string; name: string }>>('/api/classes')
      .then((r) => live && setClasses(Array.isArray(r) ? r : []))
      .catch(() => live && setClasses([]));
    return () => {
      live = false;
    };
  }, [open]);

  // QB "Recall the last transaction for a name" (My Preferences > General): a NEW receipt for
  // this customer starts from their last one — items, rates, class, tax item and memo. Lines the
  // user already typed are kept.
  const { recall } = smart;
  useEffect(() => {
    setRecallText('');
    recalledTaxRef.current = null;
    if (!open || editing || !customerId) return;
    let live = true;
    void recall(customerId).then((d) => {
      if (!live || !d) return;
      const h = d.header;
      if (h.classId) setClassId(h.classId);
      if (h.taxRateId) {
        recalledTaxRef.current = h.taxRateId;
        setTaxRateId(h.taxRateId);
      }
      if (h.memo) {
        const m = h.memo;
        setMemo((prev) => prev || m);
      }
      if (d.lines.length > 0) {
        setLines((prev) =>
          prev.every((l) => !l.itemId && !l.description && !l.quantity && !l.rate)
            ? d.lines.map((l) => ({
                ...EMPTY_LINE,
                itemId: l.itemId ?? '',
                description: l.description ?? '',
                // Decimal, not a JS float: "9.5000" -> "9.5".
                quantity: recallQuantity(l.quantity),
                rate: recallNumber(l.rate),
                taxable: l.taxable ?? true,
                // QB recall keeps last time's rates: automatic pricing must not replace them.
                rateManual: true,
              }))
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

  function updateLine(idx: number, patch: Partial<LineRow>) {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function handleItemSelect(idx: number, itemId: string) {
    const item = items.find((i) => i.id === itemId);
    setLines((prev) => {
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        itemId,
        description: next[idx].description || item?.name || '',
        rate: item?.salesPrice ?? next[idx].rate,
        quantity: next[idx].quantity || '1',
        rateManual: false,
      };
      return next;
    });
  }

  // Advanced pricing: server-side price rules / price levels / customer prices per line.
  const quotes = usePriceQuotes(
    { customerId: customerId || null, date },
    lines.map((l) => ({ itemId: l.itemId || null, quantity: l.quantity || '1' })),
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

  function addLine() {
    setLines((prev) => [...prev, { ...EMPTY_LINE }]);
  }

  // Advanced Inventory: sites/bins + scan-to-add.
  const adv = useAdvancedInventory(open);
  function addScannedItem(it: { id: string; name: string; salesPrice?: string | null }) {
    setLines((prev) => {
      const row: LineRow = { ...EMPTY_LINE, itemId: it.id, description: it.name, quantity: '1', rate: it.salesPrice ?? '' };
      const emptyIdx = prev.findIndex((l) => !l.itemId && !l.description && !l.quantity && !l.rate);
      if (emptyIdx >= 0) return prev.map((l, i) => (i === emptyIdx ? row : l));
      return [...prev, row];
    });
  }

  function removeLine(idx: number) {
    // Keep at least one line (mirrors the per-row remove button being disabled).
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
  }

  // Line-grid keyboard ergonomics: Ctrl+Insert add / Ctrl+Delete remove / Enter down.
  const grid = useGridKeys({ addRow: addLine, removeRow: removeLine, disabled: saving });

  const selectedTaxRate = taxRates.find((t) => t.id === taxRateId);
  const { subtotal, tax, total } = computeTotals(lines, selectedTaxRate, items);

  function receiptPayload(validLines: LineRow[]) {
    return {
      ...shippingPayload(ship),
      customerId: customerId || null,
      date,
      method,
      depositAccountId: depositAccountId || null,
      reference: reference || null,
      taxRateId: taxRateId || null,
      classId: classId || null,
      memo: memo || null,
      lines: validLines.map((l) => ({
        itemId: l.itemId || null,
        description: l.description || null,
        quantity: l.quantity,
        rate: l.rate,
        taxable: l.taxable,
        ...inventoryLinePayload(l.inv),
      })),
    };
  }

  async function handleSubmit() {
    if (!date) { toast('Please enter a receipt date.', 'danger'); return; }
    const validLines = lines.filter((l) => l.itemId || l.description || l.quantity || l.rate);
    if (validLines.length === 0) { toast('Add at least one line item.', 'danger'); return; }
    for (let i = 0; i < validLines.length; i++) {
      const l = validLines[i];
      if (!l.quantity || parseFloat(l.quantity) <= 0) {
        toast(`Line ${i + 1}: quantity must be a positive number.`, 'danger'); return;
      }
      if (!l.rate || parseFloat(l.rate) < 0) {
        toast(`Line ${i + 1}: rate cannot be negative.`, 'danger'); return;
      }
    }

    setSaving(true);
    try {
      const body = { ...receiptPayload(validLines), refNumber: docNumber.payload };
      const saved = await dupConfirm.run((allowDuplicateNumber) =>
        editing
          ? api.patch<SalesReceipt>(`/api/sales-receipts/${editing.id}`, { ...body, allowDuplicateNumber })
          : api.post<SalesReceipt>('/api/sales-receipts', { ...body, allowDuplicateNumber }),
      );
      if (saved === undefined) return;
      if (!editing) smart.rememberDate(date);
      if (editing) {
        toast(`Sales Receipt #${docNo(saved.refNumber, saved.receiptNumber)} updated.`, 'success');
      } else {
        toast(`Sales Receipt #${docNo(saved.refNumber, saved.receiptNumber)} created.`, 'success');
      }
      onCreated();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to create sales receipt.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="lg"
      open={open}
      onClose={onClose}
      title={editing ? `Edit Sales Receipt #${docNo(editing.refNumber, editing.receiptNumber)}` : 'New Sales Receipt'}
      footer={
        <>
          <MemorizeButton
            docType="sales_receipt"
            shortcut={open}
            defaultName={customers.find((c) => c.id === customerId)?.displayName}
            getTemplate={() => {
              const valid = lines.filter((l) => l.itemId || l.description || l.quantity || l.rate);
              if (valid.length === 0) return 'Add at least one line before memorizing.';
              const p = receiptPayload(valid);
              // Lot / serial picks are one-time: each memorized entry picks fresh stock.
              return {
                ...p,
                reference: null,
                lines: p.lines.map((l) => ({
                  itemId: l.itemId,
                  description: l.description,
                  quantity: l.quantity,
                  rate: l.rate,
                  taxable: l.taxable,
                })),
              };
            }}
          />
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>
            {editing ? 'Save Changes' : 'Create Receipt'}
          </Button>
        </>
      }
    >
      {!editing && prefill?.note && (
        <div className="mb-3">
          <PrefillNotice note={prefill.note} />
        </div>
      )}
      <div className="space-y-4">
        {/* Ctrl+Y / Ctrl+H: the journal entry this receipt posted (components/KeyboardCommands.tsx). */}
        {editing && <span hidden data-source-ref={`salesreceipt:${editing.id}`} />}
        {editing && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Saving changes re-posts this sale (and puts back / takes out any stock) so your books stay
            balanced. If it is already part of a bank deposit, its total and deposit account can&apos;t change.
          </div>
        )}
        {/* Customer (optional) + date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="sr-customer">Customer (optional)</Label>
            <Select
              id="sr-customer"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              autoFocus
            >
              <option value="">Walk-in / no customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </Select>
            {recallText && <p className="mt-1 text-xs text-electric" role="status">{recallText}</p>}
          </div>
          <div>
            <Label htmlFor="sr-date" required>Sale Date</Label>
            <DateInput
              id="sr-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <DocNumberField id="sr-number" label="Sale No." value={docNumber.value} onChange={docNumber.setValue} />
        </div>

        {/* Payment method + reference */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="sr-method">Payment Method</Label>
            <Select id="sr-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="sr-reference">Reference / Check #</Label>
            <Input
              id="sr-reference"
              placeholder="Optional"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>

        {/* Deposit to */}
        <div>
          <Label htmlFor="sr-deposit">Deposit To <Help term="undeposited-funds" /></Label>
          <Select
            id="sr-deposit"
            value={depositAccountId}
            onChange={(e) => setDepositAccountId(e.target.value)}
          >
            {!undepositedFunds && <option value="">Undeposited Funds (default)</option>}
            {depositAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-navy/50">
            Defaults to Undeposited Funds so this receipt can be grouped into a bank deposit later.
          </p>
        </div>

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

          <div className="rounded-lg border border-slate-200 overflow-hidden" onKeyDown={grid.onKeyDown}>
            {/* Header row */}
            <div className="grid grid-cols-[150px_1fr_60px_80px_44px_32px] gap-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-navy/60 border-b border-slate-200">
              <span>Item</span>
              <span>Description</span>
              <span>Qty</span>
              <span>Rate</span>
              <span>Tax</span>
              <span />
            </div>

            {lines.map((line, idx) => (
              <div
                key={idx}
                data-grid-row
                className="grid grid-cols-[150px_1fr_60px_80px_44px_32px] gap-2 items-start px-3 py-2 border-b border-slate-100 last:border-b-0"
              >
                <Select
                  value={line.itemId}
                  onChange={(e) => handleItemSelect(idx, e.target.value)}
                  aria-label="Item"
                >
                  <option value="">No item</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </Select>
                <Input
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => updateLine(idx, { description: e.target.value })}
                />
                <AmountInput
                  placeholder="1"
                  value={line.quantity}
                  onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                />
                <div>
                  <AmountInput
                    placeholder="0.00"
                    value={line.rate}
                    onChange={(e) => updateLine(idx, { rate: e.target.value, rateManual: true })}
                  />
                  <PriceSourceBadge
                    quote={quotes[idx]}
                    rate={line.rate}
                    onUseQuoted={(price) => updateLine(idx, { rate: String(Number(price)), rateManual: false })}
                  />
                </div>
                <input
                  type="checkbox"
                  checked={line.taxable}
                  onChange={(e) => updateLine(idx, { taxable: e.target.checked })}
                  className="h-4 w-4 justify-self-center accent-electric"
                  aria-label="Taxable"
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
                <InventoryLineFields
                  className="col-span-full"
                  adv={adv}
                  item={items.find((i) => i.id === line.itemId)}
                  quantity={line.quantity}
                  direction="out"
                  value={line.inv}
                  onChange={(inv) => updateLine(idx, { inv })}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Tax rate + memo */}
        <div className="grid grid-cols-2 gap-3">
          {/* Hidden while "Charge sales tax" is off (QB removes tax from forms); an old document keeps its tax. */}
          {(prefs.company.salesTaxEnabled || taxRateId) ? (<div>
            <Label htmlFor="sr-tax">Sales Tax</Label>
            <Select id="sr-tax" value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
              <option value="">No tax</option>
              {taxRates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({(parseFloat(t.rate) * 100).toFixed(2)}%)
                </option>
              ))}
            </Select>
          </div>) : <div />}
          <div>
            <Label htmlFor="sr-memo">Memo</Label>
            <Input
              id="sr-memo"
              placeholder="Optional"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
          {/* Class fields are hidden while "Use class tracking" is off (QB); a saved class still shows. */}
          {(prefs.company.classTrackingEnabled || classId) && (
            <div>
              <Label htmlFor="sr-class">Class (optional)</Label>
              <Select id="sr-class" value={classId} onChange={(e) => setClassId(e.target.value)}>
                <option value="">No class</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <ShippingSection value={ship} onChange={setShip} shipTos={custDefaults?.shipTos} idPrefix="sr-ship" />
        {dupConfirm.dialog}

        {/* Live totals */}
        <div className="rounded-lg bg-navy/5 px-4 py-3 space-y-1">
          <div className="flex items-center justify-between text-sm text-navy/70">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatCurrency(subtotal.toFixed(2))}</span>
          </div>
          <div className="flex items-center justify-between text-sm text-navy/70">
            <span>Tax</span>
            <span className="tabular-nums">{formatCurrency(tax.toFixed(2))}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-navy/70">Total Received</span>
            <span className="text-lg font-bold text-navy tabular-nums">
              {formatCurrency(total.toFixed(2))}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SalesReceiptsPage() {
  const [receipts, setReceipts] = useState<SalesReceipt[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  // cmdbar: the command bar opens a NEW sales receipt filled in for the user to save.
  const [prefill, setPrefill] = useState<FormPrefill | null>(null);
  usePrefill('sales_receipt', (p) => {
    setEditTarget(null);
    setPrefill(p);
    setShowNew(true);
  });

  // Void state
  const [voidTarget, setVoidTarget] = useState<SalesReceipt | null>(null);
  const [editTarget, setEditTarget] = useState<SalesReceiptDetail | null>(null);

  async function openEdit(r: SalesReceipt) {
    try {
      setEditTarget(await api.get<SalesReceiptDetail>(`/api/sales-receipts/${r.id}`));
    } catch (err: unknown) {
      toastError(err, 'Could not open the sales receipt.');
    }
  }
  const [voiding, setVoiding] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [receiptList, custList, itemRes, acctList, taxList] = await Promise.all([
        api.get<SalesReceipt[]>('/api/sales-receipts'),
        api.get<Customer[]>('/api/customers'),
        api.get<{ items: Item[] }>('/api/items'),
        api.get<Account[]>('/api/accounts'),
        api.get<TaxRate[]>('/api/tax-rates'),
      ]);
      setReceipts(receiptList);
      setCustomers(custList);
      setItems(itemRes.items ?? []);
      setAccounts(acctList);
      setTaxRates(taxList);
    } catch (err: unknown) {
      toastError(err, 'Failed to load sales receipts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleVoid() {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      await api.del(`/api/sales-receipts/${voidTarget.id}`);
      toast(`Sales Receipt #${docNo(voidTarget.refNumber, voidTarget.receiptNumber)} voided.`, 'success');
      setVoidTarget(null);
      fetchData();
    } catch (err: unknown) {
      toastError(err, 'Failed to void sales receipt.');
    } finally {
      setVoiding(false);
    }
  }

  const activeReceipts = receipts.filter((r) => r.status !== 'void');

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Sales Receipts"
        icon={Receipt}
        action={
          <Button onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New Sales Receipt
          </Button>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : receipts.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No sales receipts yet"
            message="Use a sales receipt when a customer pays at the time of sale. If they will pay later, create an invoice instead."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> New Sales Receipt
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Receipt #</Th>
                <Th>Customer</Th>
                <Th>Date</Th>
                <Th>Method</Th>
                <Th numeric>Tax</Th>
                <Th numeric>Total</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <Tr key={r.id} id={`sales-receipt-row-${r.id}`}>
                  <Td className="font-semibold text-navy">#{docNo(r.refNumber, r.receiptNumber)}</Td>
                  <Td>{r.customerName ?? 'Walk-in'}</Td>
                  <Td className="text-navy/70">{formatDate(r.date)}</Td>
                  <Td className="text-navy/70">{methodLabel(r.method)}</Td>
                  <Td numeric>{formatCurrency(r.taxAmount)}</Td>
                  <Td numeric className="font-medium">{formatCurrency(r.total)}</Td>
                  <Td>
                    <Badge tone={r.status === 'void' ? 'void' : 'paid'}>
                      {r.status === 'void' ? 'Void' : 'Paid'}
                    </Badge>
                  </Td>
                  <Td className="text-right">
                    {r.status !== 'void' && <FormSendButtons kind="sales_receipt" id={r.id} />}
                    {r.status !== 'void' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Edit sales receipt"
                        aria-label="Edit sales receipt"
                        onClick={() => openEdit(r)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {r.status !== 'void' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setVoidTarget(r)}
                        className="text-red-500 hover:bg-red-50"
                        title="Void sales receipt"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Void
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Summary footer */}
      {receipts.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {receipts.length} receipt{receipts.length !== 1 ? 's' : ''}
          </span>
          <span>
            Total sales:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(
                activeReceipts.reduce((s, r) => s + Number(r.total), 0).toFixed(2),
              )}
            </span>
          </span>
        </div>
      )}

      <NewReceiptModal
        open={showNew || !!editTarget}
        editing={editTarget}
        onClose={() => {
          setShowNew(false);
          setEditTarget(null);
          setPrefill(null);
        }}
        prefill={editTarget ? null : prefill}
        customers={customers}
        items={items}
        accounts={accounts}
        taxRates={taxRates}
        onCreated={fetchData}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void Sales Receipt"
        message={
          <>
            Are you sure you want to void <strong>Sales Receipt #{docNo(voidTarget?.refNumber, voidTarget?.receiptNumber)}</strong>?
            This will reverse the income and payment posting, restore any inventory sold, and cannot
            be undone.
          </>
        }
        confirmLabel="Void Receipt"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />
    </main>
  );
}
