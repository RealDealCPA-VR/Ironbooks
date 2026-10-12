'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  Package,
  PackageSearch,
  RefreshCw,
  ClipboardCheck,
  ClipboardList,
  DollarSign,
  Printer,
  BarChart3,
} from 'lucide-react';
import {
  Button,
  Card,
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
  EmptyState,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency, Money } from '@/lib/money';
import { CreatePosFromReorder, StockStatusByVendor } from '@/components/lists/ReorderTools';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReorderRow {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: string;
  reorderPoint: string;
  averageCost: string;
  suggestedReorderQty: string;
}

interface ReorderReport {
  rows: ReorderRow[];
  count: number;
}

interface Item {
  id: string;
  name: string;
  sku: string | null;
  type: string;
  quantityOnHand: string | null;
  averageCost: string | null;
}

interface PhysicalCountResult {
  itemId: string;
  previousQty: string;
  countedQty: string;
  delta: string;
  glAmount: string;
  journalEntryId: string | null;
  adjustmentAccountId: string | null;
  updatedQty: string;
}

interface ValuationRow {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: string;
  averageCost: string;
  totalValue: string;
  costingMethod: 'fifo' | 'average';
}

interface ValueAdjustResult {
  itemId: string;
  costingMethod: 'fifo' | 'average';
  quantity: string;
  oldValue: string;
  newValue: string;
  delta: string;
  journalEntryId: string;
  newUnitCost: string;
}

interface WorksheetRow {
  id: string;
  name: string;
  sku: string | null;
  unitOfMeasure: string | null;
  quantityOnHand: string;
  averageCost: string;
  fifoTracked: boolean;
}

interface BatchCountResult {
  applied: PhysicalCountResult[];
  skipped: Array<{ itemId: string; reason: string }>;
}

interface StockStatusRow {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: string;
  committed: string;
  available: string;
  onPO: string;
  reorderPoint: string | null;
  suggestedOrder: string;
}

interface StockStatusData {
  rows: StockStatusRow[];
  attentionCount: number;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Physical Count Modal (single item)
// ---------------------------------------------------------------------------

interface PhysicalCountModalProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

function PhysicalCountModal({ open, onClose, onDone }: PhysicalCountModalProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemId, setItemId] = useState('');
  const [countedQty, setCountedQty] = useState('');
  const [date, setDate] = useState(todayStr);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<PhysicalCountResult | null>(null);

  useEffect(() => {
    if (!open) {
      setItemId('');
      setCountedQty('');
      setDate(todayStr());
      setResult(null);
      return;
    }
    setLoadingItems(true);
    api
      .get<{ items: Item[] }>('/api/items?type=inventory')
      .then((data) => setItems(data.items ?? []))
      .catch(() => toast('Failed to load items.', 'danger'))
      .finally(() => setLoadingItems(false));
  }, [open]);

  const selectedItem = items.find((i) => i.id === itemId);

  async function handleSubmit() {
    if (!itemId) {
      toast('Please select an item.', 'danger');
      return;
    }
    const qty = parseFloat(countedQty);
    if (countedQty === '' || isNaN(qty) || qty < 0) {
      toast('Please enter a valid counted quantity (>= 0).', 'danger');
      return;
    }
    if (!date) {
      toast('Please enter a count date.', 'danger');
      return;
    }

    setSaving(true);
    try {
      const data = await api.post<PhysicalCountResult>('/api/inventory/physical-count', {
        itemId,
        countedQty: countedQty,
        date,
      });
      setResult(data);
      toast('Physical count recorded.', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to record physical count.';
      toast(msg, 'danger');
    } finally {
      setSaving(false);
    }
  }

  function handleDone() {
    setResult(null);
    onDone();
    onClose();
  }

  const deltaNum = result ? parseFloat(result.delta) : 0;

  return (
    <Modal
      open={open}
      onClose={result ? handleDone : onClose}
      title="Physical Inventory Count"
      footer={
        result ? (
          <Button onClick={handleDone}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="physical-count-form" loading={saving} disabled={loadingItems}>
              Record Count
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-navy/5 p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-navy/60">Item</span>
              <span className="font-semibold text-navy">
                {items.find((i) => i.id === result.itemId)?.name ?? result.itemId}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-navy/60">Previous Qty</span>
              <span className="font-medium text-navy tabular-nums">{result.previousQty}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-navy/60">Counted Qty</span>
              <span className="font-medium text-navy tabular-nums">{result.countedQty}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-navy/60">Delta</span>
              <span
                className={`font-semibold tabular-nums ${
                  deltaNum < 0 ? 'text-red-600' : deltaNum > 0 ? 'text-emerald' : 'text-navy/50'
                }`}
              >
                {deltaNum > 0 ? '+' : ''}{result.delta}
              </span>
            </div>
            <div className="flex justify-between text-sm border-t border-navy/10 pt-3">
              <span className="text-navy/60">GL Adjustment</span>
              <span className="font-bold text-navy tabular-nums">
                {formatCurrency(result.glAmount)}
              </span>
            </div>
            {result.journalEntryId ? (
              <div className="flex justify-between text-xs">
                <span className="text-navy/40">Journal Entry</span>
                <Link
                  href={`/journal?focus=${result.journalEntryId}`}
                  className="text-electric font-semibold hover:underline"
                >
                  View entry
                </Link>
              </div>
            ) : (
              <p className="text-xs text-navy/40 italic">No GL entry needed (delta = 0).</p>
            )}
          </div>
          {deltaNum !== 0 && (
            <div
              className={`rounded-lg px-4 py-3 text-sm font-medium ${
                deltaNum < 0 ? 'bg-red-50 text-red-700' : 'bg-emerald/10 text-emerald'
              }`}
            >
              {deltaNum < 0
                ? `Shrinkage of ${Math.abs(deltaNum).toFixed(4)} units recorded. Dr Inventory Shrinkage, Cr Inventory Asset.`
                : `Overage of ${deltaNum.toFixed(4)} units recorded. Dr Inventory Asset, Cr Inventory Shrinkage.`}
            </div>
          )}
        </div>
      ) : (
        <form
          id="physical-count-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          className="space-y-4"
        >
          <div>
            <Label htmlFor="pc-item">Item *</Label>
            {loadingItems ? (
              <div className="flex items-center gap-2 text-sm text-navy/40 py-2">
                <Spinner className="h-4 w-4" /> Loading items…
              </div>
            ) : (
              <Select
                id="pc-item"
                autoFocus
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
              >
                <option value="">Select an inventory item…</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.sku ? ` (${item.sku})` : ''}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {selectedItem && (
            <div className="rounded-lg bg-navy/5 px-4 py-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-navy/60">Current Qty on Hand</span>
                <span className="font-semibold text-navy tabular-nums">
                  {selectedItem.quantityOnHand ?? '—'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-navy/60">Average Cost</span>
                <span className="font-medium text-navy tabular-nums">
                  {selectedItem.averageCost ? formatCurrency(selectedItem.averageCost) : '—'}
                </span>
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="pc-qty">Counted Quantity *</Label>
            <Input
              id="pc-qty"
              type="number"
              min="0"
              step="any"
              placeholder="0"
              value={countedQty}
              onChange={(e) => setCountedQty(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="pc-date">Count Date *</Label>
            <Input id="pc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Value Adjustment Modal
// ---------------------------------------------------------------------------

function ValueAdjustModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<ValuationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [itemId, setItemId] = useState('');
  const [mode, setMode] = useState<'total' | 'unit'>('total');
  const [value, setValue] = useState('');
  const [date, setDate] = useState(todayStr);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ValueAdjustResult | null>(null);

  useEffect(() => {
    if (!open) {
      setItemId('');
      setMode('total');
      setValue('');
      setDate(todayStr());
      setReason('');
      setResult(null);
      return;
    }
    setLoading(true);
    api
      .get<{ items: ValuationRow[] }>('/api/inventory')
      .then((data) => setRows((data.items ?? []).filter((r) => parseFloat(r.quantityOnHand) > 0)))
      .catch(() => toast('Failed to load inventory valuation.', 'danger'))
      .finally(() => setLoading(false));
  }, [open]);

  const selected = rows.find((r) => r.id === itemId);

  async function handleSubmit() {
    if (!itemId) {
      toast('Please select an item.', 'danger');
      return;
    }
    const v = parseFloat(value);
    if (value === '' || isNaN(v) || v < 0) {
      toast('Please enter a valid non-negative value.', 'danger');
      return;
    }
    if (!date) {
      toast('Please enter an adjustment date.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const data = await api.post<ValueAdjustResult>('/api/inventory/value-adjust', {
        itemId,
        newTotalValue: mode === 'total' ? value : undefined,
        newUnitCost: mode === 'unit' ? value : undefined,
        date,
        reason: reason || undefined,
      });
      setResult(data);
      toast('Inventory value adjusted.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to adjust value.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  function handleDone() {
    setResult(null);
    onDone();
    onClose();
  }

  const deltaNum = result ? parseFloat(result.delta) : 0;

  return (
    <Modal
      open={open}
      onClose={result ? handleDone : onClose}
      title="Inventory Value Adjustment"
      footer={
        result ? (
          <Button onClick={handleDone}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="value-adjust-form" loading={saving} disabled={loading}>
              Adjust Value
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-navy/5 p-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-navy/60">Item</span>
              <span className="font-semibold text-navy">
                {rows.find((r) => r.id === result.itemId)?.name ?? result.itemId}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-navy/60">Costing Method</span>
              <Badge tone="info">{result.costingMethod}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-navy/60">Old Value</span>
              <span className="tabular-nums">{formatCurrency(result.oldValue)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-navy/60">New Value</span>
              <span className="tabular-nums font-semibold">{formatCurrency(result.newValue)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-navy/60">New Unit Cost</span>
              <span className="tabular-nums">{formatCurrency(result.newUnitCost)}</span>
            </div>
            <div className="flex justify-between border-t border-navy/10 pt-3">
              <span className="text-navy/60">GL Adjustment</span>
              <span
                className={`font-bold tabular-nums ${deltaNum < 0 ? 'text-red-600' : 'text-emerald'}`}
              >
                {deltaNum > 0 ? '+' : ''}{formatCurrency(result.delta)}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-navy/40">Journal Entry</span>
              <Link
                href={`/journal?focus=${result.journalEntryId}`}
                className="text-electric font-semibold hover:underline"
              >
                View entry
              </Link>
            </div>
          </div>
          <p className="text-xs text-navy/40">
            {deltaNum < 0
              ? 'Write-down posted: Dr Inventory Adjustment (5900), Cr Inventory Asset.'
              : 'Write-up posted: Dr Inventory Asset, Cr Inventory Adjustment (5900).'}
            {result.costingMethod === 'fifo'
              ? ' Remaining FIFO layers were revalued.'
              : ' Average cost was updated; quantity on hand is unchanged.'}
          </p>
        </div>
      ) : (
        <form
          id="value-adjust-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          className="space-y-4"
        >
          <div>
            <Label htmlFor="va-item">Item *</Label>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-navy/40 py-2">
                <Spinner className="h-4 w-4" /> Loading valuation…
              </div>
            ) : (
              <Select id="va-item" autoFocus value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <option value="">Select an item with stock on hand…</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.sku ? ` (${r.sku})` : ''} — {r.costingMethod}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {selected && (
            <div className="rounded-lg bg-navy/5 px-4 py-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-navy/60">Qty on Hand</span>
                <span className="font-semibold tabular-nums">{selected.quantityOnHand}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-navy/60">Unit Cost</span>
                <span className="tabular-nums">{formatCurrency(selected.averageCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-navy/60">Current Total Value</span>
                <span className="font-semibold tabular-nums">{formatCurrency(selected.totalValue)}</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="va-mode">Adjust By</Label>
              <Select
                id="va-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'total' | 'unit')}
              >
                <option value="total">New total value</option>
                <option value="unit">New unit cost</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="va-value">{mode === 'total' ? 'New Total Value *' : 'New Unit Cost *'}</Label>
              <Input
                id="va-value"
                type="number"
                min="0"
                step="any"
                placeholder="0.00"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </div>

          {selected && value !== '' && !isNaN(parseFloat(value)) && (
            <p className="text-xs text-navy/50">
              Adjustment:{' '}
              <span className="font-semibold tabular-nums">
                {formatCurrency(
                  Money.sub(
                    mode === 'total' ? value : Money.mul(value, selected.quantityOnHand),
                    selected.totalValue,
                  ),
                )}
              </span>{' '}
              vs Inventory Adjustment (5900)
            </p>
          )}

          <div>
            <Label htmlFor="va-date">Date *</Label>
            <Input id="va-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div>
            <Label htmlFor="va-reason">Reason</Label>
            <Input
              id="va-reason"
              placeholder="e.g. Damaged stock written down"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Batch Count Modal (count sheet entry grid)
// ---------------------------------------------------------------------------

function BatchCountModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<WorksheetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [date, setDate] = useState(todayStr);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<BatchCountResult | null>(null);

  useEffect(() => {
    if (!open) {
      setCounts({});
      setDate(todayStr());
      setResult(null);
      return;
    }
    setLoading(true);
    api
      .get<{ rows: WorksheetRow[] }>('/api/inventory/worksheet')
      .then((data) => setRows(data.rows ?? []))
      .catch(() => toast('Failed to load the count worksheet.', 'danger'))
      .finally(() => setLoading(false));
  }, [open]);

  const entered = rows.filter((r) => !r.fifoTracked && counts[r.id] !== undefined && counts[r.id] !== '');

  async function handleApply() {
    if (entered.length === 0) {
      toast('Enter at least one counted quantity.', 'danger');
      return;
    }
    for (const r of entered) {
      const v = parseFloat(counts[r.id]);
      if (isNaN(v) || v < 0) {
        toast(`Invalid count for ${r.name}.`, 'danger');
        return;
      }
    }
    setSaving(true);
    try {
      const data = await api.post<BatchCountResult>('/api/inventory/batch-count', {
        date,
        counts: entered.map((r) => ({ itemId: r.id, countedQty: counts[r.id] })),
      });
      setResult(data);
      toast(`Applied ${data.applied.length} count(s).`, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to apply counts.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  function handleDone() {
    setResult(null);
    onDone();
    onClose();
  }

  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  return (
    <Modal
      open={open}
      onClose={result ? handleDone : onClose}
      title="Batch Count Entry"
      size="lg"
      footer={
        result ? (
          <Button onClick={handleDone}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleApply} loading={saving} disabled={loading || entered.length === 0}>
              Apply {entered.length > 0 ? `${entered.length} ` : ''}Count{entered.length === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <div className="rounded-lg bg-emerald/10 px-4 py-3 text-sm font-medium text-emerald">
            {result.applied.length} count(s) applied
            {result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}.
          </div>
          {result.applied.length > 0 && (
            <Table>
              <thead>
                <Tr>
                  <Th>Item</Th>
                  <Th numeric>Previous</Th>
                  <Th numeric>Counted</Th>
                  <Th numeric>Delta</Th>
                  <Th numeric>GL Amount</Th>
                </Tr>
              </thead>
              <tbody>
                {result.applied.map((a) => (
                  <Tr key={a.itemId}>
                    <Td className="font-medium text-navy">{nameById.get(a.itemId) ?? a.itemId}</Td>
                    <Td numeric>{a.previousQty}</Td>
                    <Td numeric>{a.countedQty}</Td>
                    <Td
                      numeric
                      className={
                        parseFloat(a.delta) < 0
                          ? 'text-red-600 font-semibold'
                          : parseFloat(a.delta) > 0
                            ? 'text-emerald font-semibold'
                            : ''
                      }
                    >
                      {a.delta}
                    </Td>
                    <Td numeric>{formatCurrency(a.glAmount)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          {result.skipped.length > 0 && (
            <div className="rounded-lg bg-gold/10 px-4 py-3 text-sm text-navy/70 space-y-1">
              <p className="font-semibold text-navy">Skipped:</p>
              {result.skipped.map((s) => (
                <p key={s.itemId}>
                  <span className="font-medium">{nameById.get(s.itemId) ?? s.itemId}</span> — {s.reason}
                </p>
              ))}
            </div>
          )}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-navy/40 text-sm">
          <Spinner className="h-4 w-4" /> Loading worksheet…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No inventory items"
          message="Create inventory-type items first, then run a physical count."
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-end gap-4">
            <div>
              <Label htmlFor="bc-date">Count Date *</Label>
              <Input id="bc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <p className="text-xs text-navy/50 pb-2">
              Leave a row blank to skip it. Differences post as shrinkage/overage vs account 5900.
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <thead>
                <Tr>
                  <Th>Item</Th>
                  <Th>SKU</Th>
                  <Th numeric>On Hand</Th>
                  <Th className="w-36">Counted</Th>
                  <Th numeric>Difference</Th>
                </Tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const counted = counts[r.id] ?? '';
                  const diff =
                    counted === '' || isNaN(parseFloat(counted))
                      ? null
                      : parseFloat(counted) - parseFloat(r.quantityOnHand);
                  return (
                    <Tr key={r.id}>
                      <Td className="font-medium text-navy">
                        {r.name}
                        {r.fifoTracked && (
                          <Badge tone="warning" className="ml-2">
                            FIFO — count via FIFO adjustments
                          </Badge>
                        )}
                      </Td>
                      <Td className="text-navy/50 text-xs">{r.sku ?? '—'}</Td>
                      <Td numeric className="tabular-nums">{parseFloat(r.quantityOnHand).toFixed(2)}</Td>
                      <Td>
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          disabled={r.fifoTracked}
                          value={counted}
                          placeholder={r.fifoTracked ? 'n/a' : ''}
                          onChange={(e) => setCounts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        />
                      </Td>
                      <Td
                        numeric
                        className={
                          diff == null
                            ? 'text-navy/30'
                            : diff < 0
                              ? 'text-red-600 font-semibold'
                              : diff > 0
                                ? 'text-emerald font-semibold'
                                : 'text-navy/40'
                        }
                      >
                        {diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(4)}`}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function InventoryOpsPage() {
  const [report, setReport] = useState<ReorderReport | null>(null);
  const [stock, setStock] = useState<StockStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPhysicalCount, setShowPhysicalCount] = useState(false);
  const [showValueAdjust, setShowValueAdjust] = useState(false);
  const [showBatchCount, setShowBatchCount] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [reorder, status] = await Promise.all([
        api.get<ReorderReport>('/api/inventory/reorder'),
        api.get<StockStatusData>('/api/inventory/stock-status'),
      ]);
      setReport(reorder);
      setStock(status);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load inventory reports.';
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  function downloadWorksheet() {
    const a = document.createElement('a');
    a.href = '/api/inventory/worksheet?format=csv';
    a.download = 'physical-inventory-worksheet.csv';
    a.click();
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Inventory Operations"
        icon={PackageSearch}
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" onClick={fetchAll} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button variant="secondary" onClick={downloadWorksheet}>
              <Printer className="h-4 w-4" />
              Count Worksheet
            </Button>
            <Button variant="secondary" onClick={() => setShowBatchCount(true)}>
              <ClipboardList className="h-4 w-4" />
              Batch Count
            </Button>
            <Button variant="secondary" onClick={() => setShowValueAdjust(true)}>
              <DollarSign className="h-4 w-4" />
              Value Adjustment
            </Button>
            <Button onClick={() => setShowPhysicalCount(true)}>
              <ClipboardCheck className="h-4 w-4" />
              Physical Count
            </Button>
          </div>
        }
      />

      {/* Stock Status by Item */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-navy">Stock Status by Item</h2>
          <p className="text-sm text-navy/50 mt-0.5">
            Committed = open sales-order quantity not yet invoiced. Available = on hand − committed.
            On PO = open purchase-order quantity not yet billed.
          </p>
        </div>
        {stock && (
          <Badge tone={stock.attentionCount > 0 ? 'warning' : 'success'}>
            {stock.attentionCount === 0
              ? 'No stock issues'
              : `${stock.attentionCount} item${stock.attentionCount !== 1 ? 's' : ''} need attention`}
          </Badge>
        )}
      </div>

      <Card className="p-0 overflow-hidden mb-10">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading stock status…
          </div>
        ) : !stock || stock.rows.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="No inventory items"
            message="Inventory-type items appear here with their committed, available, and on-order quantities."
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Item</Th>
                <Th>SKU</Th>
                <Th numeric>On Hand</Th>
                <Th numeric>Committed</Th>
                <Th numeric>Available</Th>
                <Th numeric>On PO</Th>
                <Th numeric>Reorder Pt</Th>
                <Th numeric>Suggested Order</Th>
              </Tr>
            </thead>
            <tbody>
              {stock.rows.map((row) => {
                const available = parseFloat(row.available);
                const suggested = parseFloat(row.suggestedOrder);
                return (
                  <Tr key={row.id}>
                    <Td className="font-semibold text-navy">{row.name}</Td>
                    <Td className="text-navy/50 text-xs">{row.sku ?? '—'}</Td>
                    <Td numeric>{parseFloat(row.quantityOnHand).toFixed(2)}</Td>
                    <Td numeric className={parseFloat(row.committed) > 0 ? 'text-electric font-semibold' : 'text-navy/50'}>
                      {parseFloat(row.committed).toFixed(2)}
                    </Td>
                    <Td numeric>
                      <span className={available < 0 ? 'text-red-600 font-bold' : available === 0 ? 'text-gold font-semibold' : 'text-navy'}>
                        {available.toFixed(2)}
                      </span>
                    </Td>
                    <Td numeric className="text-navy/70">{parseFloat(row.onPO).toFixed(2)}</Td>
                    <Td numeric className="text-navy/70">
                      {row.reorderPoint == null ? '—' : parseFloat(row.reorderPoint).toFixed(2)}
                    </Td>
                    <Td numeric>
                      {suggested > 0 ? (
                        <span className="font-semibold text-electric">{suggested.toFixed(2)}</span>
                      ) : (
                        <span className="text-navy/30">—</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Reorder Report */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-navy">Reorder Report</h2>
          <p className="text-sm text-navy/50 mt-0.5">
            Items where quantity on hand is at or below the reorder point.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {report && (
            <Badge tone={report.count > 0 ? 'danger' : 'success'}>
              {report.count === 0
                ? 'All items stocked'
                : `${report.count} item${report.count !== 1 ? 's' : ''} need reorder`}
            </Badge>
          )}
          <CreatePosFromReorder disabled={!report || report.count === 0} onDone={fetchAll} />
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading reorder report…
          </div>
        ) : !report || report.rows.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No items need reordering right now"
            message="Items appear here when their quantity on hand falls to or below their reorder point."
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Item</Th>
                <Th>SKU</Th>
                <Th numeric>On Hand</Th>
                <Th numeric>Reorder Point</Th>
                <Th numeric>Avg Cost</Th>
                <Th numeric>Suggested Order</Th>
                <Th numeric>Est. Cost</Th>
              </Tr>
            </thead>
            <tbody>
              {report.rows.map((row) => {
                const belowZero = parseFloat(row.quantityOnHand) <= 0;
                const estCost = Money.mul(row.suggestedReorderQty, row.averageCost);

                return (
                  <Tr key={row.id}>
                    <Td className="font-semibold text-navy">{row.name}</Td>
                    <Td className="text-navy/50 text-xs">{row.sku ?? '—'}</Td>
                    <Td numeric>
                      <span className={belowZero ? 'text-red-600 font-bold' : 'text-gold font-semibold'}>
                        {parseFloat(row.quantityOnHand).toFixed(2)}
                      </span>
                    </Td>
                    <Td numeric className="text-navy/70">
                      {parseFloat(row.reorderPoint).toFixed(2)}
                    </Td>
                    <Td numeric className="text-navy/70">
                      {formatCurrency(row.averageCost)}
                    </Td>
                    <Td numeric className="font-semibold text-electric">
                      {parseFloat(row.suggestedReorderQty).toFixed(2)}
                    </Td>
                    <Td numeric className="text-navy/70">
                      {formatCurrency(estCost)}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {report && report.rows.length > 0 && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {report.count} item{report.count !== 1 ? 's' : ''} below reorder point
          </span>
          <span>
            Total estimated reorder cost:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(
                report.rows.reduce(
                  (sum, r) => sum.plus(Money.mul(r.suggestedReorderQty, r.averageCost)),
                  Money.zero(),
                ),
              )}
            </span>
          </span>
        </div>
      )}

      <StockStatusByVendor />

      <PhysicalCountModal
        open={showPhysicalCount}
        onClose={() => setShowPhysicalCount(false)}
        onDone={fetchAll}
      />
      <ValueAdjustModal
        open={showValueAdjust}
        onClose={() => setShowValueAdjust(false)}
        onDone={fetchAll}
      />
      <BatchCountModal
        open={showBatchCount}
        onClose={() => setShowBatchCount(false)}
        onDone={fetchAll}
      />
    </main>
  );
}
