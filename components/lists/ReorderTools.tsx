'use client';
/**
 * Reorder tools for the Inventory Operations page:
 *  - <CreatePosFromReorder/>: preview, then create one purchase order per preferred vendor for
 *    everything on the reorder list (POST /api/inventory/reorder/create-po);
 *  - <StockStatusByVendor/>: Inventory Stock Status by Vendor (GET /api/inventory/stock-by-vendor).
 */
import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ShoppingCart, Truck } from 'lucide-react';
import { Button, Card, Input, Modal, Spinner, Table, Td, Th, Tr, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

interface PlannedPo {
  vendorId: string;
  vendorName: string;
  total: string;
  lines: Array<{ itemId: string; name: string; quantity: string; rate: string }>;
  poNumber?: number | null;
}
interface PlanResult {
  dryRun: boolean;
  purchaseOrders: PlannedPo[];
  withoutVendor: Array<{ itemId: string; name: string }>;
}

export function CreatePosFromReorder({ disabled, onDone }: { disabled?: boolean; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function preview() {
    setBusy(true);
    try {
      const r = await api.post<PlanResult>('/api/inventory/reorder/create-po', { dryRun: true });
      setPlan(r);
      setQty(Object.fromEntries(r.purchaseOrders.flatMap((p) => p.lines.map((l) => [l.itemId, String(Number(l.quantity))]))));
      setOpen(true);
    } catch (err) {
      toastError(err, 'Could not prepare purchase orders.');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!plan) return;
    setBusy(true);
    try {
      const itemIds = plan.purchaseOrders.flatMap((p) => p.lines.map((l) => l.itemId));
      const r = await api.post<PlanResult>('/api/inventory/reorder/create-po', { itemIds, quantities: qty });
      toast(
        `Created ${r.purchaseOrders.length} purchase order${r.purchaseOrders.length === 1 ? '' : 's'}: ` +
          r.purchaseOrders.map((p) => `#${p.poNumber ?? ''} ${p.vendorName}`).join(', '),
        'success',
      );
      setOpen(false);
      onDone?.();
    } catch (err) {
      toastError(err, 'Could not create the purchase orders.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={preview} loading={busy} disabled={disabled}>
        <ShoppingCart className="h-4 w-4" /> Create purchase orders
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create purchase orders from the reorder list"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={!plan || plan.purchaseOrders.length === 0}>
              Create {plan?.purchaseOrders.length ?? 0} purchase order{plan?.purchaseOrders.length === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        {plan && (
          <div className="flex flex-col gap-4">
            {plan.purchaseOrders.map((p) => (
              <div key={p.vendorId} className="rounded-lg border border-slate-200 p-3">
                <p className="mb-2 font-semibold text-navy">{p.vendorName}</p>
                <Table>
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th numeric>Order qty</Th>
                      <Th numeric>Cost each</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.lines.map((l) => (
                      <Tr key={l.itemId}>
                        <Td>{l.name}</Td>
                        <Td numeric>
                          <Input
                            aria-label={`Order quantity for ${l.name}`}
                            type="number"
                            min="0"
                            step="any"
                            className="w-24 text-right"
                            value={qty[l.itemId] ?? ''}
                            onChange={(e) => setQty((prev) => ({ ...prev, [l.itemId]: e.target.value }))}
                          />
                        </Td>
                        <Td numeric>{formatCurrency(l.rate)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ))}
            {plan.withoutVendor.length > 0 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                No preferred vendor, so not ordered: {plan.withoutVendor.map((w) => w.name).join(', ')}. Set a preferred vendor
                on the <Link href="/items" className="underline">Items page</Link>.
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

interface VendorGroup {
  vendorId: string | null;
  vendorName: string;
  rows: Array<{ id: string; name: string; quantityOnHand: string; available: string; onPO: string; reorderPoint: string | null; suggestedOrder: string }>;
}

export function StockStatusByVendor() {
  const [groups, setGroups] = useState<VendorGroup[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const d = await api.get<{ groups: VendorGroup[] }>('/api/inventory/stock-by-vendor');
      setGroups(d.groups);
    } catch (err) {
      toastError(err, 'Could not load stock status by vendor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-navy">Stock Status by Vendor</h2>
          <p className="mt-0.5 text-sm text-navy/50">The same stock picture, grouped by each item&apos;s preferred vendor.</p>
        </div>
        <Button variant="secondary" onClick={load} loading={loading}>
          <Truck className="h-4 w-4" /> {groups ? 'Refresh' : 'Show'}
        </Button>
      </div>
      {loading && !groups ? (
        <Spinner className="h-4 w-4" />
      ) : groups ? (
        <Card className="overflow-hidden p-0">
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th numeric>On hand</Th>
                <Th numeric>Available</Th>
                <Th numeric>On PO</Th>
                <Th numeric>Reorder pt</Th>
                <Th numeric>Suggested order</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.vendorId ?? 'none'}>
                  <tr className="bg-navy/5">
                    <td colSpan={6} className="px-4 py-2 text-sm font-semibold text-navy">
                      {g.vendorName}
                    </td>
                  </tr>
                  {g.rows.map((r) => (
                    <Tr key={`${g.vendorId ?? 'none'}-${r.id}`}>
                      <Td>{r.name}</Td>
                      <Td numeric>{Number(r.quantityOnHand)}</Td>
                      <Td numeric>{Number(r.available)}</Td>
                      <Td numeric>{Number(r.onPO)}</Td>
                      <Td numeric>{r.reorderPoint == null ? '—' : Number(r.reorderPoint)}</Td>
                      <Td numeric>{Number(r.suggestedOrder) > 0 ? Number(r.suggestedOrder) : '—'}</Td>
                    </Tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </section>
  );
}
