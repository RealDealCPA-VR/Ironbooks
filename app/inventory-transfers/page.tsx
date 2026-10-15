'use client';

/**
 * Transfer Inventory — QB Desktop Enterprise "Transfer Inventory" between sites.
 * List of transfers + New Transfer (from/to site, item lines with bins, serial and lot
 * numbers, scan-to-add) + Void. Transfers move quantity only; they never touch the GL.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, Ban, MinusCircle, Plus, PlusCircle } from 'lucide-react';
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
  useGridKeys,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatDate } from '@/lib/utils';
import {
  BarcodeScanInput,
  InventoryLineFields,
  type InvDetail,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';

interface Site {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
}

interface Item {
  id: string;
  name: string;
  type: string;
  trackingMode?: string | null;
}

interface Transfer {
  id: string;
  transferNumber: number;
  date: string;
  fromSiteName: string;
  toSiteName: string;
  status: 'posted' | 'void';
  memo: string | null;
  lineCount: number;
  totalQuantity: string;
}

interface LineRow {
  itemId: string;
  quantity: string;
  /** Source side: bin / serials / lot. */
  from: InvDetail;
  /** Destination bin. */
  toBinId: string;
}

const emptyLine = (): LineRow => ({ itemId: '', quantity: '', from: {}, toBinId: '' });

export default function InventoryTransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingVoid, setPendingVoid] = useState<Transfer | null>(null);
  const [voiding, setVoiding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setTransfers(await api.get<Transfer[]>('/api/inventory-transfers'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load transfers.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api.get<Site[]>('/api/inventory-sites').then(setSites).catch(() => undefined);
    api
      .get<{ items: Item[] }>('/api/items?type=inventory')
      .then((d) => setItems(d.items ?? []))
      .catch(() => undefined);
  }, [refresh]);

  async function handleVoid() {
    if (!pendingVoid) return;
    setVoiding(true);
    try {
      await api.post(`/api/inventory-transfers/${pendingVoid.id}`, { action: 'void' });
      toast(`Transfer #${pendingVoid.transferNumber} voided.`, 'success');
      setPendingVoid(null);
      await refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to void transfer.', 'danger');
    } finally {
      setVoiding(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Transfer Inventory"
        icon={ArrowRightLeft}
        action={
          <Button onClick={() => setModalOpen(true)} disabled={sites.length < 2}>
            <Plus className="h-4 w-4" /> New Transfer
          </Button>
        }
      />
      {sites.length < 2 && !loading && (
        <p className="mb-4 text-sm text-navy/60">
          Add a second site on the <a className="text-electric underline" href="/inventory-sites">Inventory Sites</a> page to start transferring stock.
        </p>
      )}

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner className="h-6 w-6 text-electric" />
          </div>
        ) : transfers.length === 0 ? (
          <EmptyState icon={ArrowRightLeft} title="No transfers yet" message="Move stock between your warehouses, stores and trucks." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Date</Th>
                <Th>From</Th>
                <Th>To</Th>
                <Th numeric>Lines</Th>
                <Th numeric>Units</Th>
                <Th>Memo</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <Tr key={t.id}>
                  <Td>{t.transferNumber}</Td>
                  <Td>{formatDate(t.date)}</Td>
                  <Td>{t.fromSiteName}</Td>
                  <Td>{t.toSiteName}</Td>
                  <Td numeric>{t.lineCount}</Td>
                  <Td numeric>{Number(t.totalQuantity).toLocaleString('en-US')}</Td>
                  <Td className="text-sm text-navy/60">{t.memo ?? ''}</Td>
                  <Td>
                    <Badge tone={t.status === 'void' ? 'void' : 'success'}>{t.status === 'void' ? 'Void' : 'Posted'}</Badge>
                  </Td>
                  <Td>
                    {t.status !== 'void' && (
                      <Button size="sm" variant="ghost" onClick={() => setPendingVoid(t)}>
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

      <NewTransferModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        sites={sites}
        items={items}
        onCreated={refresh}
      />

      <ConfirmDialog
        open={!!pendingVoid}
        title="Void transfer?"
        message={`Void transfer #${pendingVoid?.transferNumber}? The stock moves back to ${pendingVoid?.fromSiteName}.`}
        confirmLabel="Void"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}

function NewTransferModal({
  open,
  onClose,
  sites,
  items,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  sites: Site[];
  items: Item[];
  onCreated: () => Promise<void>;
}) {
  const adv = useAdvancedInventory(open);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fromSiteId, setFromSiteId] = useState('');
  const [toSiteId, setToSiteId] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDate(new Date().toISOString().slice(0, 10));
    setFromSiteId(sites.find((s) => s.isDefault)?.id ?? '');
    setToSiteId('');
    setMemo('');
    setLines([emptyLine()]);
  }, [open, sites]);

  const toBins = adv.bins.filter((b) => b.siteId === toSiteId && b.isActive);

  // Line grid keys: Enter / Down next line (adds one at the end), Up previous, Ctrl+Insert insert,
  // Ctrl+D delete (the last remaining line is kept, as with the remove button).
  const addLine = useCallback(() => setLines((p) => [...p, emptyLine()]), []);
  const insertLine = useCallback((at: number) => setLines((p) => [...p.slice(0, at), emptyLine(), ...p.slice(at)]), []);
  const removeLine = useCallback((idx: number) => setLines((p) => (p.length > 1 ? p.filter((_, i) => i !== idx) : p)), []);
  const grid = useGridKeys({ addRow: addLine, insertRow: insertLine, removeRow: removeLine, disabled: saving });

  function update(idx: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function addScanned(it: { id: string }) {
    setLines((prev) => {
      const empty = prev.findIndex((l) => !l.itemId && !l.quantity);
      const row = { ...emptyLine(), itemId: it.id, quantity: '1' };
      if (empty >= 0) return prev.map((l, i) => (i === empty ? row : l));
      // Scanning the same item again bumps its quantity.
      const same = prev.findIndex((l) => l.itemId === it.id);
      if (same >= 0) return prev.map((l, i) => (i === same ? { ...l, quantity: String((Number(l.quantity) || 0) + 1) } : l));
      return [...prev, row];
    });
  }

  async function submit() {
    if (!fromSiteId || !toSiteId) return toast('Choose both sites.', 'danger');
    if (fromSiteId === toSiteId) return toast('Choose two different sites.', 'danger');
    const valid = lines.filter((l) => l.itemId);
    if (valid.length === 0) return toast('Add at least one item.', 'danger');
    for (const [i, l] of valid.entries()) {
      if (!(Number(l.quantity) > 0)) return toast(`Line ${i + 1}: quantity must be greater than zero.`, 'danger');
    }
    setSaving(true);
    try {
      await api.post('/api/inventory-transfers', {
        date,
        fromSiteId,
        toSiteId,
        memo: memo || null,
        lines: valid.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity,
          fromBinId: l.from.binId || null,
          toBinId: l.toBinId || null,
          serialNumbers: l.from.serialNumbers?.length ? l.from.serialNumbers : null,
          lotNumber: l.from.lotNumber || null,
        })),
      });
      toast('Inventory transferred.', 'success');
      await onCreated();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Transfer failed.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Transfer Inventory"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Transfer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="tr-date">Date *</Label>
            <DateInput id="tr-date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="tr-from">From site *</Label>
            <Select
              id="tr-from"
              value={fromSiteId}
              onChange={(e) => {
                setFromSiteId(e.target.value);
                setLines((prev) => prev.map((l) => ({ ...l, from: { ...l.from, siteId: e.target.value, binId: undefined } })));
              }}
            >
              <option value="">Choose…</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tr-to">To site *</Label>
            <Select
              id="tr-to"
              value={toSiteId}
              onChange={(e) => {
                setToSiteId(e.target.value);
                setLines((prev) => prev.map((l) => ({ ...l, toBinId: '' })));
              }}
            >
              <option value="">Choose…</option>
              {sites
                .filter((s) => s.id !== fromSiteId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="mb-0">Items</Label>
            <div className="flex items-center gap-2">
              <BarcodeScanInput onItem={addScanned} />
              <Button size="sm" variant="ghost" onClick={addLine}>
                <PlusCircle className="h-4 w-4" /> Add line
              </Button>
            </div>
          </div>
          <div className="space-y-2" onKeyDown={grid.onKeyDown}>
            {lines.map((line, idx) => {
              const item = items.find((i) => i.id === line.itemId);
              return (
                <div key={idx} data-grid-row className="space-y-1 rounded-lg border border-slate-200 p-2">
                  <div className="grid grid-cols-[1fr_90px_150px_28px] items-center gap-2">
                    <Select value={line.itemId} onChange={(e) => update(idx, { itemId: e.target.value, from: { siteId: fromSiteId } })}>
                      <option value="">Item…</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </Select>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      className="text-right"
                      placeholder="Qty"
                      value={line.quantity}
                      onChange={(e) => update(idx, { quantity: e.target.value })}
                    />
                    {toBins.length > 0 ? (
                      <Select aria-label="Destination bin" value={line.toBinId} onChange={(e) => update(idx, { toBinId: e.target.value })}>
                        <option value="">To bin: none</option>
                        {toBins.map((b) => (
                          <option key={b.id} value={b.id}>
                            To bin {b.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      aria-label="Remove line"
                      disabled={lines.length === 1}
                      onClick={() => removeLine(idx)}
                      className="flex items-center justify-center text-navy/30 hover:text-red-500 disabled:opacity-20"
                    >
                      <MinusCircle className="h-4 w-4" />
                    </button>
                  </div>
                  {item && (
                    <InventoryLineFields
                      adv={adv}
                      siteLocked
                      item={item}
                      quantity={line.quantity}
                      direction="out"
                      value={{ ...line.from, siteId: fromSiteId }}
                      onChange={(from) => update(idx, { from })}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <Label htmlFor="tr-memo">Memo</Label>
          <Input id="tr-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
        </div>
      </div>
    </Modal>
  );
}
