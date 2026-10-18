'use client';

import { Fragment, useEffect, useState } from 'react';
import { Layers, Plus, ArrowDownCircle, ArrowUpCircle, ChevronDown, ChevronRight } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  Select,
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
import { todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import {
  InventoryAdjustmentFields,
  EMPTY_ADJUSTMENT_FIELDS,
  adjustmentPayload,
  type AdjustmentFieldValues,
} from '@/components/InventoryAdjustmentFields';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FifoLayer {
  layerId: string;
  date: string;
  quantityRemaining: string;
  unitCost: string;
  layerValue: string;
}

interface FifoItem {
  itemId: string;
  itemName: string;
  sku: string | null;
  layers: FifoLayer[];
  totalQuantity: string;
  totalValue: string;
}

interface FifoValuation {
  items: FifoItem[];
  grandTotal: string;
}

interface ItemOption {
  id: string;
  name: string;
  sku: string | null;
}

// ---------------------------------------------------------------------------
// Receive modal form
// ---------------------------------------------------------------------------

interface ReceiveForm {
  itemId: string;
  quantity: string;
  unitCost: string;
  date: string;
  memo: string;
}

const EMPTY_RECEIVE: ReceiveForm = {
  itemId: '',
  quantity: '',
  unitCost: '',
  date: todayISO(),
  memo: '',
};

// ---------------------------------------------------------------------------
// Consume modal form
// ---------------------------------------------------------------------------

interface ConsumeForm {
  itemId: string;
  quantity: string;
  date: string;
  memo: string;
}

const EMPTY_CONSUME: ConsumeForm = {
  itemId: '',
  quantity: '',
  date: todayISO(),
  memo: '',
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FifoPage() {
  const [valuation, setValuation] = useState<FifoValuation | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ItemOption[]>([]);

  // Expanded rows
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Receive modal
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveForm, setReceiveForm] = useState<ReceiveForm>(EMPTY_RECEIVE);
  const [receiveSaving, setReceiveSaving] = useState(false);
  const [receiveAdj, setReceiveAdj] = useState<AdjustmentFieldValues>(EMPTY_ADJUSTMENT_FIELDS);

  // Consume modal
  const [consumeOpen, setConsumeOpen] = useState(false);
  const [consumeForm, setConsumeForm] = useState<ConsumeForm>(EMPTY_CONSUME);
  const [consumeSaving, setConsumeSaving] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchValuation() {
    setLoading(true);
    try {
      const data = await api.get<FifoValuation>('/api/fifo');
      setValuation(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load FIFO valuation', 'danger');
    } finally {
      setLoading(false);
    }
  }

  async function fetchItems() {
    try {
      const data = await api.get<{ items: ItemOption[] }>('/api/items?type=inventory');
      setItems(data.items ?? []);
    } catch {
      // non-critical; items list degrades gracefully
    }
  }

  useEffect(() => {
    fetchValuation();
    fetchItems();
  }, []);

  // ---------------------------------------------------------------------------
  // Receive stock
  // ---------------------------------------------------------------------------

  function openReceive() {
    setReceiveForm(EMPTY_RECEIVE);
    setReceiveAdj(EMPTY_ADJUSTMENT_FIELDS);
    setReceiveOpen(true);
  }

  function updateReceive(field: keyof ReceiveForm, value: string) {
    setReceiveForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleReceive() {
    if (!receiveForm.itemId) { toast('Item is required', 'danger'); return; }
    if (!receiveForm.quantity || Number(receiveForm.quantity) <= 0) {
      toast('Quantity must be positive', 'danger'); return;
    }
    if (!receiveForm.unitCost || Number(receiveForm.unitCost) < 0) {
      toast('Unit cost cannot be negative', 'danger'); return;
    }
    if (!receiveForm.date) { toast('Date is required', 'danger'); return; }

    setReceiveSaving(true);
    try {
      await api.post('/api/fifo', {
        action: 'receive',
        itemId: receiveForm.itemId,
        quantity: receiveForm.quantity,
        unitCost: receiveForm.unitCost,
        date: receiveForm.date,
        memo: receiveForm.memo || undefined,
        ...adjustmentPayload(receiveAdj),
      });
      toast('Stock received and inventory layer recorded', 'success');
      setReceiveOpen(false);
      await fetchValuation();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to receive stock', 'danger');
    } finally {
      setReceiveSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Consume stock
  // ---------------------------------------------------------------------------

  function openConsume(itemId?: string) {
    setConsumeForm({ ...EMPTY_CONSUME, itemId: itemId ?? '' });
    setConsumeOpen(true);
  }

  function updateConsume(field: keyof ConsumeForm, value: string) {
    setConsumeForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleConsume() {
    if (!consumeForm.itemId) { toast('Item is required', 'danger'); return; }
    if (!consumeForm.quantity || Number(consumeForm.quantity) <= 0) {
      toast('Quantity must be positive', 'danger'); return;
    }
    if (!consumeForm.date) { toast('Date is required', 'danger'); return; }

    setConsumeSaving(true);
    try {
      await api.post('/api/fifo', {
        action: 'consume',
        itemId: consumeForm.itemId,
        quantity: consumeForm.quantity,
        date: consumeForm.date,
        memo: consumeForm.memo || undefined,
      });
      toast('Stock consumed and COGS posted', 'success');
      setConsumeOpen(false);
      await fetchValuation();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to consume stock', 'danger');
    } finally {
      setConsumeSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Expand/collapse rows
  // ---------------------------------------------------------------------------

  function toggleExpanded(itemId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const itemSelectOptions = items.map((i) => (
    <option key={i.id} value={i.id}>
      {i.name}{i.sku ? ` (${i.sku})` : ''}
    </option>
  ));

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="FIFO Inventory Valuation"
        icon={Layers}
        action={
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => openConsume()}>
              <ArrowUpCircle className="h-4 w-4" />
              Consume Stock
            </Button>
            <Button onClick={openReceive}>
              <Plus className="h-4 w-4" />
              Receive Stock
            </Button>
          </div>
        }
      />

      <Card>
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-12 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading FIFO valuation...
          </div>
        ) : !valuation || valuation.items.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No inventory layers yet"
            message="Receive stock to record your first FIFO cost layer."
            action={
              <Button onClick={openReceive}>
                <Plus className="h-4 w-4" />
                Receive Stock
              </Button>
            }
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th></Th>
                  <Th>Item</Th>
                  <Th>SKU</Th>
                  <Th numeric>Total Qty</Th>
                  <Th numeric>FIFO Value</Th>
                  <Th numeric>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {valuation.items.map((item) => (
                  <Fragment key={item.itemId}>
                    <Tr>
                      <Td>
                        <button
                          onClick={() => toggleExpanded(item.itemId)}
                          className="text-navy/40 hover:text-navy transition-colors"
                          title={expanded.has(item.itemId) ? 'Collapse layers' : 'Expand layers'}
                        >
                          {expanded.has(item.itemId) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </Td>
                      <Td className="font-semibold text-navy">{item.itemName}</Td>
                      <Td className="text-navy/60 text-xs">{item.sku ?? '-'}</Td>
                      <Td numeric className="text-navy">
                        {parseFloat(item.totalQuantity).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </Td>
                      <Td numeric className="font-semibold text-navy">
                        {formatCurrency(item.totalValue)}
                      </Td>
                      <Td numeric>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openConsume(item.itemId)}
                          title="Consume stock from this item (FIFO)"
                        >
                          <ArrowUpCircle className="h-3.5 w-3.5" />
                          Consume
                        </Button>
                      </Td>
                    </Tr>

                    {expanded.has(item.itemId) &&
                      item.layers.map((layer, idx) => (
                        <tr
                          key={layer.layerId}
                          className="bg-slate-50 text-xs text-navy/70 border-b border-slate-100"
                        >
                          <Td></Td>
                          <Td colSpan={1} className="pl-8 text-navy/50">
                            Layer {idx + 1}
                          </Td>
                          <Td className="text-navy/50">{formatDate(layer.date)}</Td>
                          <Td numeric>
                            {parseFloat(layer.quantityRemaining).toLocaleString(undefined, {
                              maximumFractionDigits: 4,
                            })}{' '}
                            <span className="text-navy/40">@ {formatCurrency(layer.unitCost)}</span>
                          </Td>
                          <Td numeric>
                            {formatCurrency(layer.layerValue)}
                          </Td>
                          <Td></Td>
                        </tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </Table>

            {/* Grand total footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100">
              <span className="text-sm font-semibold text-navy/60 uppercase tracking-wide">
                Grand Total
              </span>
              <span className="tabular-nums text-lg font-bold text-navy">
                {formatCurrency(valuation.grandTotal)}
              </span>
            </div>
          </>
        )}
      </Card>

      {/* ---- Receive stock modal ---- */}
      <Modal
        open={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        title="Receive Stock"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReceiveOpen(false)} disabled={receiveSaving}>
              Cancel
            </Button>
            <Button type="submit" form="receive-form" loading={receiveSaving}>
              <ArrowDownCircle className="h-4 w-4" />
              Receive &amp; Post GL
            </Button>
          </>
        }
      >
        <form
          id="receive-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleReceive();
          }}
          className="flex flex-col gap-4"
        >
          <div>
            <Label htmlFor="receive-item">Item *</Label>
            <Select
              id="receive-item"
              autoFocus
              value={receiveForm.itemId}
              onChange={(e) => updateReceive('itemId', e.target.value)}
            >
              <option value="">-- select item --</option>
              {itemSelectOptions}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="receive-qty">Quantity *</Label>
              <Input
                id="receive-qty"
                type="number"
                min="0.0001"
                step="0.0001"
                placeholder="10"
                value={receiveForm.quantity}
                onChange={(e) => updateReceive('quantity', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="receive-cost">Unit Cost *</Label>
              <Input
                id="receive-cost"
                type="number"
                min="0"
                step="0.0001"
                placeholder="5.00"
                value={receiveForm.unitCost}
                onChange={(e) => updateReceive('unitCost', e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="receive-date">Date *</Label>
            <Input
              id="receive-date"
              type="date"
              value={receiveForm.date}
              onChange={(e) => updateReceive('date', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="receive-memo">Memo</Label>
            <Input
              id="receive-memo"
              placeholder="e.g. PO #1234"
              value={receiveForm.memo}
              onChange={(e) => updateReceive('memo', e.target.value)}
            />
          </div>
          <InventoryAdjustmentFields value={receiveAdj} onChange={setReceiveAdj} idPrefix="receive-adj" />
          <p className="text-xs text-navy/50">
            Adds quantity &times; unit cost to inventory. The other side goes to the adjustment account
            (Inventory Adjustments unless you pick another).
          </p>
        </form>
      </Modal>

      {/* ---- Consume stock modal ---- */}
      <Modal
        open={consumeOpen}
        onClose={() => setConsumeOpen(false)}
        title="Consume Stock (FIFO)"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConsumeOpen(false)} disabled={consumeSaving}>
              Cancel
            </Button>
            <Button type="submit" form="consume-form" loading={consumeSaving}>
              <ArrowUpCircle className="h-4 w-4" />
              Consume &amp; Post COGS
            </Button>
          </>
        }
      >
        <form
          id="consume-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleConsume();
          }}
          className="flex flex-col gap-4"
        >
          <div>
            <Label htmlFor="consume-item">Item *</Label>
            <Select
              id="consume-item"
              autoFocus
              value={consumeForm.itemId}
              onChange={(e) => updateConsume('itemId', e.target.value)}
            >
              <option value="">-- select item --</option>
              {itemSelectOptions}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="consume-qty">Quantity *</Label>
              <Input
                id="consume-qty"
                type="number"
                min="0.0001"
                step="0.0001"
                placeholder="12"
                value={consumeForm.quantity}
                onChange={(e) => updateConsume('quantity', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="consume-date">Date *</Label>
              <Input
                id="consume-date"
                type="date"
                value={consumeForm.date}
                onChange={(e) => updateConsume('date', e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="consume-memo">Memo</Label>
            <Input
              id="consume-memo"
              placeholder="e.g. Sale order #5678"
              value={consumeForm.memo}
              onChange={(e) => updateConsume('memo', e.target.value)}
            />
          </div>
          <p className="text-xs text-navy/50">
            Oldest cost layers are depleted first (FIFO). GL: Dr 5000 COGS / Cr 1300 Inventory.
          </p>
        </form>
      </Modal>
    </main>
  );
}
