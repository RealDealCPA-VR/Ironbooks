'use client';

/**
 * Landed Cost — spread freight, duty and other charges from a vendor bill onto the items
 * they relate to (QB Desktop Enterprise Advanced Inventory). Pick the charge line, the item
 * receipts, and a method (quantity / value / weight); preview the split, then post. Units
 * still on hand absorb the cost into inventory; units already sold send their share to COGS.
 */
import { useCallback, useEffect, useState } from 'react';
import { Ban, Calculator, Plus, Ship } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Input,
  Label,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

interface Allocation {
  id: string;
  date: string;
  billId: string;
  billNumber: string | null;
  vendorName: string;
  chargeAccountName: string;
  method: 'quantity' | 'value' | 'weight';
  amount: string;
  status: 'posted' | 'void';
  memo: string | null;
}

interface Source {
  billId: string;
  billNumber: string | null;
  billDate: string;
  vendorName: string;
  billLineId: string;
  description: string | null;
  accountName: string;
  amount: string;
  allocated: string;
  remaining: string;
}

interface Receipt {
  id: string;
  date: string;
  reference: string | null;
  vendorId: string;
  status: 'open' | 'billed' | 'void';
  total: string;
}

interface Vendor {
  id: string;
  displayName: string;
}

interface PreviewLine {
  itemReceiptId: string;
  itemName: string;
  quantity: string;
  lineValue: string;
  basis: string;
  amount: string;
  inventoryAmount: string;
  cogsAmount: string;
}

const METHOD_LABELS: Record<Allocation['method'], string> = {
  quantity: 'By quantity',
  value: 'By value',
  weight: 'By weight',
};

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export default function LandedCostPage() {
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [pendingVoid, setPendingVoid] = useState<Allocation | null>(null);
  const [voiding, setVoiding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAllocations(await api.get<Allocation[]>('/api/landed-cost'));
    } catch (err) {
      toast(errMsg(err, 'Failed to load landed cost.'), 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleVoid() {
    if (!pendingVoid) return;
    setVoiding(true);
    try {
      await api.post(`/api/landed-cost/${pendingVoid.id}`, { action: 'void' });
      toast('Landed cost allocation voided.', 'success');
      setPendingVoid(null);
      await refresh();
    } catch (err) {
      toast(errMsg(err, 'Failed to void allocation.'), 'danger');
    } finally {
      setVoiding(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Landed Cost"
        icon={Ship}
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Allocate Charges
          </Button>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Enter freight, duty or handling on a vendor bill as an expense line (e.g. Freight-In), then
        allocate it here onto the item receipts it belongs to. The charge moves out of the expense
        account and into the cost of your inventory.
      </p>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner className="h-6 w-6 text-electric" />
          </div>
        ) : allocations.length === 0 ? (
          <EmptyState icon={Ship} title="No landed cost allocated yet" message="Allocate a bill's freight or duty onto received items." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Bill</Th>
                <Th>Vendor</Th>
                <Th>Charge</Th>
                <Th>Method</Th>
                <Th numeric>Amount</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {allocations.map((a) => (
                <Tr key={a.id}>
                  <Td>{formatDate(a.date)}</Td>
                  <Td>{a.billNumber ? `#${a.billNumber}` : '—'}</Td>
                  <Td>{a.vendorName}</Td>
                  <Td>{a.chargeAccountName}</Td>
                  <Td>{METHOD_LABELS[a.method]}</Td>
                  <Td numeric>{formatCurrency(a.amount)}</Td>
                  <Td>
                    <Badge tone={a.status === 'void' ? 'void' : 'success'}>{a.status === 'void' ? 'Void' : 'Posted'}</Badge>
                  </Td>
                  <Td>
                    {a.status !== 'void' && (
                      <Button size="sm" variant="ghost" onClick={() => setPendingVoid(a)}>
                        <Ban className="h-4 w-4" /> Void
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <AllocateModal open={open} onClose={() => setOpen(false)} onPosted={refresh} />

      <ConfirmDialog
        open={!!pendingVoid}
        title="Void landed cost?"
        message="The charge moves back to its expense account and the item costs return to what they were. Only possible while the stock hasn't moved since."
        confirmLabel="Void"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}

function AllocateModal({ open, onClose, onPosted }: { open: boolean; onClose: () => void; onPosted: () => Promise<void> }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [vendors, setVendors] = useState<Map<string, string>>(new Map());
  const [sourceKey, setSourceKey] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<Allocation['method']>('value');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [memo, setMemo] = useState('');
  const [preview, setPreview] = useState<PreviewLine[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSourceKey('');
    setSelected(new Set());
    setMethod('value');
    setAmount('');
    setDate('');
    setMemo('');
    setPreview(null);
    Promise.all([
      api.get<Source[]>('/api/landed-cost?sources=1'),
      api.get<Receipt[]>('/api/item-receipts'),
      api.get<Vendor[]>('/api/vendors'),
    ])
      .then(([s, r, v]) => {
        setSources(s);
        setReceipts(r.filter((x) => x.status !== 'void'));
        setVendors(new Map(v.map((x) => [x.id, x.displayName])));
      })
      .catch((err) => toast(errMsg(err, 'Failed to load bills and receipts.'), 'danger'));
  }, [open]);

  const source = sources.find((s) => s.billLineId === sourceKey);

  function body() {
    return {
      billId: source?.billId,
      billLineId: source?.billLineId,
      method,
      amount: amount || null,
      itemReceiptIds: [...selected],
      date: date || null,
      memo: memo || null,
    };
  }

  async function runPreview() {
    if (!source) return toast('Choose the charge to allocate.', 'danger');
    if (selected.size === 0) return toast('Select at least one item receipt.', 'danger');
    setBusy(true);
    try {
      const res = await api.post<{ lines: PreviewLine[] }>('/api/landed-cost/preview', body());
      setPreview(res.lines);
    } catch (err) {
      setPreview(null);
      toast(errMsg(err, 'Could not compute the allocation.'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    setBusy(true);
    try {
      await api.post('/api/landed-cost', body());
      toast('Landed cost posted.', 'success');
      await onPosted();
      onClose();
    } catch (err) {
      toast(errMsg(err, 'Failed to post landed cost.'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  const receiptLabel = (r: Receipt) =>
    `${formatDate(r.date)} — ${vendors.get(r.vendorId) ?? 'Vendor'}${r.reference ? ` — ${r.reference}` : ''} (${formatCurrency(r.total)})`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Allocate Landed Cost"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={runPreview} loading={busy}>
            <Calculator className="h-4 w-4" /> Preview
          </Button>
          <Button onClick={post} disabled={!preview || busy}>
            Post Allocation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="lc-source">Charge to allocate *</Label>
          <Select
            id="lc-source"
            value={sourceKey}
            onChange={(e) => {
              setSourceKey(e.target.value);
              setPreview(null);
              const s = sources.find((x) => x.billLineId === e.target.value);
              setAmount(s ? String(Number(s.remaining)) : '');
            }}
          >
            <option value="">{sources.length ? 'Choose a bill charge line…' : 'No unallocated bill charges'}</option>
            {sources.map((s) => (
              <option key={s.billLineId} value={s.billLineId}>
                {`${formatDate(s.billDate)} · ${s.vendorName} · Bill ${s.billNumber ?? '—'} · ${s.accountName}${s.description ? ` (${s.description})` : ''} · ${formatCurrency(s.remaining)} left`}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="lc-method">Allocate by</Label>
            <Select
              id="lc-method"
              value={method}
              onChange={(e) => {
                setMethod(e.target.value as Allocation['method']);
                setPreview(null);
              }}
            >
              <option value="value">Value (cost of the goods)</option>
              <option value="quantity">Quantity (units)</option>
              <option value="weight">Weight (item unit weight)</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="lc-amount">Amount</Label>
            <Input
              id="lc-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setPreview(null);
              }}
            />
          </div>
          <div>
            <Label htmlFor="lc-date">Posting date</Label>
            <DateInput id="lc-date" value={date} onChange={(e) => setDate(e.target.value)} />
            <p className="mt-1 text-xs text-navy/40">Blank = bill date</p>
          </div>
        </div>

        <div>
          <Label>Item receipts *</Label>
          <div className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {receipts.length === 0 && <p className="px-3 py-4 text-sm text-navy/40">No item receipts yet.</p>}
            {receipts.map((r) => (
              <label key={r.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50">
                <input
                  type="checkbox"
                  className="accent-electric"
                  checked={selected.has(r.id)}
                  onChange={() => {
                    setPreview(null);
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      return next;
                    });
                  }}
                />
                {receiptLabel(r)}
              </label>
            ))}
          </div>
        </div>

        <div>
          <Label htmlFor="lc-memo">Memo</Label>
          <Input id="lc-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
        </div>

        {preview && (
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th numeric>Qty</Th>
                <Th numeric>Value</Th>
                <Th numeric>Allocated</Th>
                <Th numeric>To inventory</Th>
                <Th numeric>To COGS</Th>
              </tr>
            </thead>
            <tbody>
              {preview.map((l, i) => (
                <Tr key={i}>
                  <Td>{l.itemName}</Td>
                  <Td numeric>{Number(l.quantity)}</Td>
                  <Td numeric>{formatCurrency(l.lineValue)}</Td>
                  <Td numeric className="font-semibold">
                    {formatCurrency(l.amount)}
                  </Td>
                  <Td numeric>{formatCurrency(l.inventoryAmount)}</Td>
                  <Td numeric>{formatCurrency(l.cogsAmount)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Modal>
  );
}
