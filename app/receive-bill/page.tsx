'use client';

/**
 * Enter Bill for Received Items (QB Enterprise "Enhanced Inventory Receiving").
 * Pick a vendor, choose the received-but-unbilled receipt lines the vendor is billing, enter the
 * vendor's quantities and costs, and see the quantity / price variances (vs the receipt and the
 * PO) and the exact journal entry before saving. Receiving preferences live here too.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileInput, Settings2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
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
import { formatDate } from '@/lib/format';

interface OpenLine {
  receiptId: string;
  receiptDate: string;
  reference: string | null;
  purchaseOrderId: string | null;
  poNumber: number | null;
  /** P.O. No. the user sees (typed ref number). */
  poRef?: string | null;
  lineId: string;
  itemId: string;
  itemName: string;
  itemType: string;
  description: string | null;
  quantityReceived: string;
  quantityBilled: string;
  quantityOpen: string;
  receiptUnitCost: string;
  poUnitCost: string | null;
  poQuantityOrdered: string | null;
}
interface PreviewLine {
  receiptLineId: string;
  quantityRemaining: string;
  quantityWrittenOff: string;
  accrualAmount: string;
  billAmount: string;
  priceVariance: string;
  poPriceVariance: string | null;
  writeOffVariance: string;
  varianceMode: 'inventory' | 'ppv' | 'expense' | 'none';
  inventoryVariance: string;
  expensedVariance: string;
}
interface Preview {
  lines: PreviewLine[];
  billTotal: string;
  accrualRelieved: string;
  totalVariance: string;
  postingLines: Array<{ accountId: string; accountName: string; debit: string | null; credit: string | null; memo: string }>;
}
interface Settings {
  enhancedReceiving: boolean;
  varianceMode: 'inventory' | 'ppv';
  ppvAccountId: string | null;
}
interface Row {
  include: boolean;
  quantity: string;
  unitCost: string;
  closeLine: boolean;
}

function q(v: string | null | undefined): string {
  if (v == null) return '—';
  return String(Math.round(Number(v) * 10000) / 10000);
}

const MODE_LABEL: Record<PreviewLine['varianceMode'], string> = {
  inventory: 'to item cost',
  ppv: 'to PPV',
  expense: 'to expense',
  none: '',
};

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [accounts, setAccounts] = useState<Array<{ id: string; code: string; name: string; type: string }>>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.get<Settings>('/api/receiving/settings').then(setS).catch(() => toast('Failed to load preferences.', 'danger'));
    api.get<Array<{ id: string; code: string; name: string; type: string }>>('/api/accounts').then(setAccounts).catch(() => {});
  }, [open]);
  async function save() {
    if (!s) return;
    setSaving(true);
    try {
      await api.patch('/api/receiving/settings', s);
      toast('Receiving preferences saved.', 'success');
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save.', 'danger');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Receiving preferences"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!s}>Save</Button>
        </>
      }
    >
      {!s ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 accent-electric" checked={s.enhancedReceiving} onChange={(e) => setS({ ...s, enhancedReceiving: e.target.checked })} />
            <span>
              <span className="font-semibold text-navy">Enhanced receiving</span>
              <span className="block text-sm text-navy/60">
                Track received and billed quantities separately on purchase orders. A PO closes only when everything is received and billed.
              </span>
            </span>
          </label>
          <div>
            <Label>When the bill price differs from the receipt</Label>
            <label className="flex items-start gap-3 mb-2">
              <input type="radio" name="vm" className="mt-1 accent-electric" checked={s.varianceMode === 'inventory'} onChange={() => setS({ ...s, varianceMode: 'inventory' })} />
              <span className="text-sm text-navy">
                Adjust the item’s cost <span className="text-navy/60">(stock already sold takes the difference to Cost of Goods Sold)</span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input type="radio" name="vm" className="mt-1 accent-electric" checked={s.varianceMode === 'ppv'} onChange={() => setS({ ...s, varianceMode: 'ppv' })} />
              <span className="text-sm text-navy">Post it to a Purchase Price Variance account</span>
            </label>
          </div>
          {s.varianceMode === 'ppv' && (
            <div>
              <Label htmlFor="ppv">Purchase price variance account</Label>
              <Select id="ppv" value={s.ppvAccountId ?? ''} onChange={(e) => setS({ ...s, ppvAccountId: e.target.value || null })}>
                <option value="">Create “Purchase Price Variance” automatically</option>
                {accounts.filter((a) => a.type === 'expense').map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </Select>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function ReceiveBillPage() {
  const [vendors, setVendors] = useState<Array<{ id: string; displayName: string }>>([]);
  const [vendorId, setVendorId] = useState('');
  const [lines, setLines] = useState<OpenLine[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [loading, setLoading] = useState(false);
  const [billNumber, setBillNumber] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [memo, setMemo] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    api.get<Array<{ id: string; displayName: string }>>('/api/vendors').then(setVendors).catch(() => toast('Failed to load vendors.', 'danger'));
  }, []);

  const loadLines = useCallback(async (vid: string) => {
    if (!vid) {
      setLines([]);
      setRows({});
      return;
    }
    setLoading(true);
    try {
      const res = await api.get<{ lines: OpenLine[] }>(`/api/receiving/open-lines?vendorId=${vid}`);
      setLines(res.lines);
      setRows(
        Object.fromEntries(
          res.lines.map((l) => [l.lineId, { include: false, quantity: q(l.quantityOpen), unitCost: String(Number(l.receiptUnitCost)), closeLine: false }]),
        ),
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load received items.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLines(vendorId);
    setPreview(null);
  }, [vendorId, loadLines]);

  const payload = useMemo(() => {
    const chosen = lines.filter((l) => rows[l.lineId]?.include);
    return {
      vendorId,
      billNumber: billNumber || null,
      date,
      dueDate: dueDate || null,
      memo: memo || null,
      lines: chosen.map((l) => ({
        receiptLineId: l.lineId,
        quantity: rows[l.lineId].quantity || '0',
        unitCost: rows[l.lineId].unitCost || '0',
        closeLine: rows[l.lineId].closeLine,
      })),
    };
  }, [lines, rows, vendorId, billNumber, date, dueDate, memo]);

  // Live variance preview (debounced) from the same service that posts the bill.
  useEffect(() => {
    if (!vendorId || payload.lines.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .post<Preview>('/api/receiving/bill', { ...payload, preview: true })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err) => {
          setPreview(null);
          setPreviewError(err instanceof ApiError ? err.message : 'Cannot compute the bill.');
        });
    }, 300);
    return () => clearTimeout(t);
  }, [payload, vendorId]);

  const previewByLine = new Map((preview?.lines ?? []).map((p) => [p.receiptLineId, p]));

  function setRow(id: string, patch: Partial<Row>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function save() {
    if (payload.lines.length === 0) return toast('Select the received items on this bill.', 'danger');
    if (previewError) return toast(previewError, 'danger');
    setSaving(true);
    try {
      const bill = await api.post<{ total: string }>('/api/receiving/bill', payload);
      toast(`Bill saved for ${formatCurrency(bill.total)}.`, 'success');
      setBillNumber('');
      setMemo('');
      await loadLines(vendorId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save the bill.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Enter Bill for Received Items"
        icon={FileInput}
        action={
          <Button variant="secondary" onClick={() => setShowSettings(true)}>
            <Settings2 className="h-4 w-4" /> Receiving preferences
          </Button>
        }
      />

      <Card className="p-4 mb-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div className="md:col-span-2">
            <Label htmlFor="rb-vendor">Vendor</Label>
            <Select id="rb-vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)} autoFocus>
              <option value="">Choose a vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.displayName}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="rb-num">Vendor bill #</Label>
            <Input id="rb-num" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rb-date">Bill date</Label>
            <Input id="rb-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rb-due">Due date</Label>
            <Input id="rb-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="md:col-span-5">
            <Label htmlFor="rb-memo">Memo</Label>
            <Input id="rb-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        {!vendorId ? (
          <EmptyState icon={FileInput} title="Choose a vendor" message="You’ll see everything you received from them that hasn’t been billed yet." />
        ) : loading ? (
          <div className="flex justify-center py-16 text-navy/40"><Spinner className="h-6 w-6" /></div>
        ) : lines.length === 0 ? (
          <EmptyState icon={FileInput} title="Nothing waiting for a bill" message="Every item received from this vendor has been billed." />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th className="w-8" />
                <Th>Received</Th>
                <Th>Item</Th>
                <Th numeric>PO qty</Th>
                <Th numeric>Received</Th>
                <Th numeric>Billed</Th>
                <Th numeric>Bill qty</Th>
                <Th numeric>Receipt cost</Th>
                <Th numeric>PO cost</Th>
                <Th numeric>Bill cost</Th>
                <Th>Variance</Th>
              </Tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const r = rows[l.lineId];
                const p = previewByLine.get(l.lineId);
                const qtyShort = r?.include && Number(r.quantity) < Number(l.quantityOpen);
                return (
                  <Tr key={l.lineId}>
                    <Td>
                      <input type="checkbox" className="accent-electric" checked={!!r?.include} onChange={(e) => setRow(l.lineId, { include: e.target.checked })} aria-label={`Bill ${l.itemName}`} />
                    </Td>
                    <Td className="text-xs text-navy/70">
                      {formatDate(l.receiptDate)}
                      {l.reference && <div>Ref {l.reference}</div>}
                      {l.poNumber && <div>PO #{l.poRef || l.poNumber}</div>}
                    </Td>
                    <Td>
                      <div className="font-medium">{l.itemName}</div>
                      {l.description && l.description !== l.itemName && <div className="text-xs text-navy/50">{l.description}</div>}
                    </Td>
                    <Td numeric>{q(l.poQuantityOrdered)}</Td>
                    <Td numeric>{q(l.quantityReceived)}</Td>
                    <Td numeric className="text-navy/60">{q(l.quantityBilled)}</Td>
                    <Td numeric>
                      <Input type="number" min="0" step="any" className="w-20 ml-auto py-1 text-right" disabled={!r?.include} value={r?.quantity ?? ''} onChange={(e) => setRow(l.lineId, { quantity: e.target.value })} aria-label={`Bill quantity for ${l.itemName}`} />
                      {qtyShort && (
                        <label className="mt-1 flex items-center justify-end gap-1 text-[11px] text-navy/60">
                          <input type="checkbox" className="accent-electric" checked={r.closeLine} onChange={(e) => setRow(l.lineId, { closeLine: e.target.checked })} />
                          vendor won’t bill the rest
                        </label>
                      )}
                    </Td>
                    <Td numeric>{formatCurrency(l.receiptUnitCost)}</Td>
                    <Td numeric className="text-navy/60">{l.poUnitCost ? formatCurrency(l.poUnitCost) : '—'}</Td>
                    <Td numeric>
                      <Input type="number" min="0" step="any" className="w-24 ml-auto py-1 text-right" disabled={!r?.include} value={r?.unitCost ?? ''} onChange={(e) => setRow(l.lineId, { unitCost: e.target.value })} aria-label={`Bill unit cost for ${l.itemName}`} />
                    </Td>
                    <Td className="text-xs">
                      {r?.include && p ? (
                        <div className="space-y-0.5">
                          {Number(p.priceVariance) !== 0 && (
                            <div className={Number(p.priceVariance) > 0 ? 'text-red-600' : 'text-emerald'}>
                              Price {Number(p.priceVariance) > 0 ? '+' : ''}{formatCurrency(p.priceVariance)} {MODE_LABEL[p.varianceMode]}
                            </div>
                          )}
                          {p.poPriceVariance && Number(p.poPriceVariance) !== 0 && (
                            <div className="text-navy/50">vs PO {Number(p.poPriceVariance) > 0 ? '+' : ''}{formatCurrency(p.poPriceVariance)}</div>
                          )}
                          {Number(p.quantityWrittenOff) > 0 ? (
                            <div className="text-amber-700">Write off {q(p.quantityWrittenOff)} ({formatCurrency(p.writeOffVariance)})</div>
                          ) : Number(p.quantityRemaining) > 0 ? (
                            <div className="text-navy/60">{q(p.quantityRemaining)} stay open on the receipt</div>
                          ) : null}
                          {Number(p.inventoryVariance) !== 0 && Number(p.expensedVariance) !== 0 && (
                            <div className="text-navy/50">
                              {formatCurrency(p.inventoryVariance)} to stock · {formatCurrency(p.expensedVariance)} to COGS
                            </div>
                          )}
                          {Number(p.priceVariance) === 0 && Number(p.quantityWrittenOff) === 0 && Number(p.quantityRemaining) === 0 && (
                            <Badge tone="success">Matches receipt</Badge>
                          )}
                        </div>
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

      {(preview || previewError) && (
        <Card className="mt-4 p-5">
          {previewError ? (
            <p className="text-sm text-red-600">{previewError}</p>
          ) : preview ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-navy/60">Bill total (owed to vendor)</span><strong className="text-navy">{formatCurrency(preview.billTotal)}</strong></div>
                <div className="flex justify-between"><span className="text-navy/60">Received value relieved</span><span>{formatCurrency(preview.accrualRelieved)}</span></div>
                <div className="flex justify-between"><span className="text-navy/60">Total variance</span><span className={Number(preview.totalVariance) > 0 ? 'text-red-600' : Number(preview.totalVariance) < 0 ? 'text-emerald' : ''}>{formatCurrency(preview.totalVariance)}</span></div>
                <Button className="mt-3" onClick={save} loading={saving}>Save bill</Button>
              </div>
              <div>
                <h3 className="text-sm font-bold text-navy mb-1">Journal entry</h3>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-navy/50"><th className="text-left">Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr>
                  </thead>
                  <tbody>
                    {preview.postingLines.map((pl) => (
                      <tr key={pl.accountId} className="border-t border-slate-100">
                        <td className="py-1">{pl.accountName}</td>
                        <td className="text-right tabular-nums">{pl.debit ? formatCurrency(pl.debit) : ''}</td>
                        <td className="text-right tabular-nums">{pl.credit ? formatCurrency(pl.credit) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </Card>
      )}

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </main>
  );
}
