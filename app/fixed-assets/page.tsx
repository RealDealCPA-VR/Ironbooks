'use client';

import { useEffect, useState, useCallback } from 'react';
import { Boxes, Plus, TrendingDown, Calendar } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
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
import { formatCurrency, Money } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FixedAsset {
  id: string;
  name: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  placedInService: string;
  accumulatedDepreciation: string;
  method: string;
  isActive: boolean;
  createdAt: string;
}

interface DepreciationEntry {
  id: string;
  date: string;
  amount: string;
  postedEntryId: string | null;
}

interface ScheduleItem {
  period: number;
  date: string;
  amount: string;
  accumulated: string;
  netBookValue: string;
}

interface AssetDetail extends FixedAsset {
  depreciationEntries: DepreciationEntry[];
  schedule: ScheduleItem[];
}

interface AssetForm {
  name: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: string;
  placedInService: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const today = () => todayISO();

const EMPTY_FORM: AssetForm = {
  name: '',
  cost: '',
  salvageValue: '0',
  usefulLifeMonths: '60',
  placedInService: today(),
};

/** Decimal-safe net book value — cost minus accumulated depreciation. */
function netBookValue(asset: FixedAsset) {
  return Money.sub(asset.cost, asset.accumulatedDepreciation);
}

// ---------------------------------------------------------------------------
// Add Asset Modal
// ---------------------------------------------------------------------------

function AddAssetModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (asset: FixedAsset) => void;
}) {
  const [form, setForm] = useState<AssetForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  function set(field: keyof AssetForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const asset = await api.post<FixedAsset>('/api/fixed-assets', {
        name: form.name.trim(),
        cost: form.cost,
        salvageValue: form.salvageValue || '0',
        usefulLifeMonths: parseInt(form.usefulLifeMonths, 10),
        placedInService: form.placedInService,
      });
      toast('Asset created', 'success');
      onCreated(asset);
      setForm(EMPTY_FORM);
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create asset', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Fixed Asset"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button form="add-asset-form" type="submit" loading={saving}>
            Add Asset
          </Button>
        </>
      }
    >
      <form id="add-asset-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="fa-name">Asset Name</Label>
          <Input
            id="fa-name"
            autoFocus
            required
            placeholder="e.g. Office Server, Company Vehicle"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="fa-cost">Cost ($)</Label>
            <Input
              id="fa-cost"
              type="number"
              min="0.01"
              step="0.01"
              required
              placeholder="12000.00"
              value={form.cost}
              onChange={(e) => set('cost', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="fa-salvage">Salvage Value ($)</Label>
            <Input
              id="fa-salvage"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={form.salvageValue}
              onChange={(e) => set('salvageValue', e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="fa-life">Useful Life (months)</Label>
            <Input
              id="fa-life"
              type="number"
              min="1"
              step="1"
              required
              placeholder="60"
              value={form.usefulLifeMonths}
              onChange={(e) => set('usefulLifeMonths', e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="fa-placed">Placed in Service</Label>
            <Input
              id="fa-placed"
              type="date"
              required
              value={form.placedInService}
              onChange={(e) => set('placedInService', e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-navy/50">
          Method: Straight-Line. Monthly depreciation = (Cost - Salvage) / Useful Life.
        </p>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Record Depreciation Modal
// ---------------------------------------------------------------------------

function RecordDepreciationModal({
  asset,
  open,
  onClose,
  onPosted,
}: {
  asset: FixedAsset | null;
  open: boolean;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [date, setDate] = useState(today());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDate(today());
  }, [open]);

  if (!asset) return null;

  const depBase = Money.sub(asset.cost, asset.salvageValue);
  const monthly = Money.round2(Money.div(depBase, asset.usefulLifeMonths));
  const remaining = Money.sub(depBase, asset.accumulatedDepreciation);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/api/fixed-assets/${asset!.id}`, { action: 'depreciate', date });
      toast('Depreciation posted', 'success');
      onPosted();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to post depreciation', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record Depreciation — ${asset.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button form="dep-form" type="submit" loading={saving}>
            Post Depreciation
          </Button>
        </>
      }
    >
      <form id="dep-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-lg bg-slate-50 p-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-navy/60">Monthly Amount</span>
            <span className="font-semibold">{formatCurrency(monthly)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-navy/60">Accumulated to Date</span>
            <span className="font-semibold">{formatCurrency(asset.accumulatedDepreciation)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-navy/60">Remaining Depreciable</span>
            <span className="font-semibold text-electric">{formatCurrency(remaining)}</span>
          </div>
        </div>
        <div>
          <Label htmlFor="dep-date">Depreciation Date</Label>
          <Input
            id="dep-date"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <p className="text-xs text-navy/50">
          Posts: Dr Depreciation Expense (6800) / Cr Accumulated Depreciation (1590).
          Amount will be clamped to the remaining depreciable balance.
        </p>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Schedule Modal
// ---------------------------------------------------------------------------

function ScheduleModal({
  assetId,
  open,
  onClose,
}: {
  assetId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !assetId) return;
    setLoading(true);
    api
      .get<AssetDetail>(`/api/fixed-assets/${assetId}`)
      .then(setDetail)
      .catch(() => toast('Failed to load schedule', 'danger'))
      .finally(() => setLoading(false));
  }, [open, assetId]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={detail ? `Depreciation Schedule — ${detail.name}` : 'Depreciation Schedule'}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {loading && (
        <div className="flex items-center gap-2 text-navy/50 text-sm">
          <Spinner className="h-4 w-4" /> Loading...
        </div>
      )}
      {detail && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
            <div className="rounded-lg bg-slate-50 p-2 text-center">
              <div className="text-navy/50 text-xs">Cost</div>
              <div className="font-bold">{formatCurrency(detail.cost)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 p-2 text-center">
              <div className="text-navy/50 text-xs">Accumulated</div>
              <div className="font-bold">{formatCurrency(detail.accumulatedDepreciation)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 p-2 text-center">
              <div className="text-navy/50 text-xs">Net Book Value</div>
              <div className="font-bold text-electric">
                {formatCurrency(Money.sub(detail.cost, detail.accumulatedDepreciation))}
              </div>
            </div>
          </div>

          <div className="overflow-y-auto max-h-80">
            <Table>
              <thead>
                <tr>
                  <Th>Period</Th>
                  <Th>Date</Th>
                  <Th numeric>Amount</Th>
                  <Th numeric>Accumulated</Th>
                  <Th numeric>NBV</Th>
                  <Th className="text-center">Posted</Th>
                </tr>
              </thead>
              <tbody>
                {detail.schedule.map((row) => {
                  const entry = detail.depreciationEntries.find((e) => {
                    const eDate = new Date(e.date).toISOString().slice(0, 7);
                    const sDate = new Date(row.date).toISOString().slice(0, 7);
                    return eDate === sDate;
                  });
                  return (
                    <Tr key={row.period}>
                      <Td className="text-navy/70">{row.period}</Td>
                      <Td className="text-navy/70">{formatDate(row.date, 'MMM yyyy')}</Td>
                      <Td numeric>{formatCurrency(row.amount)}</Td>
                      <Td numeric>{formatCurrency(row.accumulated)}</Td>
                      <Td numeric className="font-medium">{formatCurrency(row.netBookValue)}</Td>
                      <Td className="text-center">
                        {entry ? (
                          <span className="inline-block w-2 h-2 rounded-full bg-emerald" title="Posted" />
                        ) : (
                          <span className="inline-block w-2 h-2 rounded-full bg-slate-200" title="Not yet posted" />
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>

          <p className="text-xs text-navy/40">
            Green dot = depreciation posted for that period.
          </p>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function FixedAssetsPage() {
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [depAsset, setDepAsset] = useState<FixedAsset | null>(null);
  const [scheduleAssetId, setScheduleAssetId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<FixedAsset[]>('/api/fixed-assets');
      setAssets(data);
    } catch {
      toast('Failed to load fixed assets', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totalCost = assets.reduce((s, a) => s.plus(Money.of(a.cost)), Money.zero());
  const totalAccumulated = assets.reduce(
    (s, a) => s.plus(Money.of(a.accumulatedDepreciation)),
    Money.zero(),
  );
  const totalNBV = totalCost.minus(totalAccumulated);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans space-y-6">
      <PageHeader
        title="Fixed Assets"
        icon={Boxes}
        action={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add Asset
          </Button>
        }
      />

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4 text-center">
          <p className="text-xs text-navy/50 mb-1">Total Cost</p>
          <p className="text-2xl font-bold text-navy">{formatCurrency(totalCost)}</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-xs text-navy/50 mb-1">Accumulated Depreciation</p>
          <p className="text-2xl font-bold text-red-500">{formatCurrency(totalAccumulated)}</p>
        </Card>
        <Card className="p-4 text-center">
          <p className="text-xs text-navy/50 mb-1">Net Book Value</p>
          <p className="text-2xl font-bold text-electric">{formatCurrency(totalNBV)}</p>
        </Card>
      </div>

      {/* Assets table */}
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-navy/50 text-sm">
            <Spinner className="h-4 w-4" /> Loading...
          </div>
        ) : assets.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No fixed assets yet"
            message="Add your first asset to start tracking depreciation."
            action={
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" />
                Add First Asset
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Asset Name</Th>
                <Th>Placed in Service</Th>
                <Th>Useful Life</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Accumulated Dep.</Th>
                <Th numeric>Net Book Value</Th>
                <Th className="text-center">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const nbv = netBookValue(asset);
                const fullyDep = Money.gte(
                  asset.accumulatedDepreciation,
                  Money.sub(asset.cost, asset.salvageValue),
                );
                return (
                  <Tr key={asset.id}>
                    <Td className="font-medium">{asset.name}</Td>
                    <Td className="text-navy/60 text-sm">{formatDate(asset.placedInService)}</Td>
                    <Td className="text-navy/60 text-sm">{asset.usefulLifeMonths} mo</Td>
                    <Td numeric className="text-sm">
                      {formatCurrency(asset.cost)}
                    </Td>
                    <Td numeric className="text-sm text-red-500">
                      {formatCurrency(asset.accumulatedDepreciation)}
                    </Td>
                    <Td numeric className="text-sm font-semibold text-electric">
                      {formatCurrency(nbv)}
                    </Td>
                    <Td className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setScheduleAssetId(asset.id)}
                          title="View depreciation schedule"
                        >
                          <Calendar className="h-3.5 w-3.5" />
                          Schedule
                        </Button>
                        {!fullyDep && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setDepAsset(asset)}
                            title="Record one period of depreciation"
                          >
                            <TrendingDown className="h-3.5 w-3.5" />
                            Depreciate
                          </Button>
                        )}
                        {fullyDep && (
                          <span className="text-xs text-navy/40 italic">Fully depreciated</span>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Modals */}
      <AddAssetModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(asset) => setAssets((prev) => [...prev, asset])}
      />

      <RecordDepreciationModal
        asset={depAsset}
        open={depAsset !== null}
        onClose={() => setDepAsset(null)}
        onPosted={load}
      />

      <ScheduleModal
        assetId={scheduleAssetId}
        open={scheduleAssetId !== null}
        onClose={() => setScheduleAssetId(null)}
      />
    </main>
  );
}
