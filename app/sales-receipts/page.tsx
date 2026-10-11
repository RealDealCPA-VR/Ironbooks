'use client';

import { useEffect, useState, useCallback } from 'react';
import { Receipt, Plus, Trash2, PlusCircle, MinusCircle } from 'lucide-react';
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
  toast,
  useGridKeys,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import {
  BarcodeScanInput,
  InventoryLineFields,
  type InvDetail,
  inventoryLinePayload,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';
import { formatDate } from '@/lib/format';
import { usePriceQuotes, samePrice } from '@/lib/usePriceQuotes';
import { PriceSourceBadge } from '@/components/PriceSourceBadge';

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
}

interface TaxRate {
  id: string;
  name: string;
  rate: string;
}

interface SalesReceipt {
  id: string;
  receiptNumber: number;
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

function computeLineTotal(line: LineRow): number {
  const qty = parseFloat(line.quantity) || 0;
  const rate = parseFloat(line.rate) || 0;
  return qty * rate;
}

function computeTotals(lines: LineRow[], taxRate: TaxRate | undefined) {
  const subtotal = lines.reduce((sum, l) => sum + computeLineTotal(l), 0);
  const taxableSubtotal = lines.reduce(
    (sum, l) => sum + (l.taxable ? computeLineTotal(l) : 0),
    0,
  );
  const tax = taxRate ? taxableSubtotal * (parseFloat(taxRate.rate) || 0) : 0;
  return { subtotal, tax, total: subtotal + tax };
}

// ---------------------------------------------------------------------------
// New Sales Receipt Modal
// ---------------------------------------------------------------------------

interface NewReceiptModalProps {
  open: boolean;
  onClose: () => void;
  customers: Customer[];
  items: Item[];
  accounts: Account[];
  taxRates: TaxRate[];
  onCreated: () => void;
}

function NewReceiptModal({
  open,
  onClose,
  customers,
  items,
  accounts,
  taxRates,
  onCreated,
}: NewReceiptModalProps) {
  const depositAccounts = accounts.filter((a) => a.type === 'asset');
  const undepositedFunds = depositAccounts.find((a) => a.code === '1050');

  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('cash');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [taxRateId, setTaxRateId] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);

  // Reset form when modal opens; deposit-to defaults to Undeposited Funds (1050)
  // so receipts flow into the Make Deposits workflow.
  useEffect(() => {
    if (open) {
      setCustomerId('');
      setDate(new Date().toISOString().slice(0, 10));
      setMethod('cash');
      setDepositAccountId(undepositedFunds?.id ?? '');
      setReference('');
      setTaxRateId('');
      setMemo('');
      setLines([{ ...EMPTY_LINE }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
  const { subtotal, tax, total } = computeTotals(lines, selectedTaxRate);

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
      await api.post('/api/sales-receipts', {
        customerId: customerId || null,
        date,
        method,
        depositAccountId: depositAccountId || null,
        reference: reference || null,
        taxRateId: taxRateId || null,
        memo: memo || null,
        lines: validLines.map((l) => ({
          itemId: l.itemId || null,
          description: l.description || null,
          quantity: l.quantity,
          rate: l.rate,
          taxable: l.taxable,
          ...inventoryLinePayload(l.inv),
        })),
      });
      toast('Sales receipt created.', 'success');
      onCreated();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create sales receipt.';
      toast(msg, 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="lg"
      open={open}
      onClose={onClose}
      title="New Sales Receipt"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>
            Create Receipt
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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
          </div>
          <div>
            <Label htmlFor="sr-date">Sale Date *</Label>
            <DateInput
              id="sr-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
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
          <Label htmlFor="sr-deposit">Deposit To</Label>
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
          <div>
            <Label htmlFor="sr-tax">Sales Tax</Label>
            <Select id="sr-tax" value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
              <option value="">No tax</option>
              {taxRates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({(parseFloat(t.rate) * 100).toFixed(2)}%)
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="sr-memo">Memo</Label>
            <Input
              id="sr-memo"
              placeholder="Optional"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        </div>

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

  // Void state
  const [voidTarget, setVoidTarget] = useState<SalesReceipt | null>(null);
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
      const msg = err instanceof Error ? err.message : 'Failed to load sales receipts.';
      toast(msg, 'danger');
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
      toast(`Sales Receipt #${voidTarget.receiptNumber} voided.`, 'success');
      setVoidTarget(null);
      fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to void sales receipt.';
      toast(msg, 'danger');
    } finally {
      setVoiding(false);
    }
  }

  const activeReceipts = receipts.filter((r) => r.status !== 'void');

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
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
            message="Record your first cash sale to get started."
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
                  <Td className="font-semibold text-navy">#{r.receiptNumber}</Td>
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
        open={showNew}
        onClose={() => setShowNew(false)}
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
            Are you sure you want to void <strong>Sales Receipt #{voidTarget?.receiptNumber}</strong>?
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
