'use client';

import { useEffect, useState, useCallback } from 'react';
import { Combine, Layers, Plus, Trash2, Hammer, Hourglass, CheckCircle2, XCircle } from 'lucide-react';
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
  PageHeader,
  EmptyState,
  Spinner,
  ConfirmDialog,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency, Money } from '@/lib/money';
import { formatShortDate } from '@/lib/format';
import { todayISO } from '@/lib/dates';
import {
  InventoryLineFields,
  type InvDetail,
  inventoryLinePayload,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';

/** Display a decimal quantity without trailing-zero noise (max 4dp). */
function formatQty(value: string | number | null | undefined): string {
  return parseFloat(String(value ?? '0') || '0').toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Item {
  id: string;
  name: string;
  sku: string | null;
  type: string;
  quantityOnHand: string | null;
  averageCost: string | null;
  isActive: boolean;
  trackingMode?: string | null;
}

interface BomRow {
  id: string;
  componentItemId: string;
  componentName: string;
  componentSku: string | null;
  quantity: string;
}

interface DraftBomRow {
  componentItemId: string;
  quantity: string;
}

interface ComponentAvailabilityRow {
  componentItemId: string;
  componentName: string;
  componentSku: string | null;
  required: string;
  onHand: string;
  shortage: string;
}

interface PendingBuild {
  id: string;
  assemblyItemId: string;
  assemblyName: string;
  assemblySku: string | null;
  quantity: string;
  date: string;
  memo: string | null;
  status: string;
  components: ComponentAvailabilityRow[];
  canBuild: boolean;
  shortageCount: number;
}

// ── Pending Builds section ────────────────────────────────────────────────────

function PendingBuildsSection({
  refreshKey,
  onStockChanged,
}: {
  refreshKey: number;
  onStockChanged: () => void;
}) {
  const [builds, setBuilds] = useState<PendingBuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<{ id: string; action: 'finalize' | 'cancel' } | null>(null);
  const [acting, setActing] = useState(false);

  const fetchBuilds = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ builds: PendingBuild[] }>('/api/assemblies/pending');
      setBuilds(data.builds ?? []);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load pending builds.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBuilds();
  }, [fetchBuilds, refreshKey]);

  async function runAction() {
    if (!confirm) return;
    setActing(true);
    try {
      await api.post(`/api/assemblies/pending/${confirm.id}`, { action: confirm.action });
      toast(confirm.action === 'finalize' ? 'Build finalized.' : 'Pending build cancelled.', 'success');
      setConfirm(null);
      await fetchBuilds();
      if (confirm.action === 'finalize') onStockChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Action failed.', 'danger');
    } finally {
      setActing(false);
    }
  }

  const confirmBuild = confirm ? builds.find((b) => b.id === confirm.id) : null;

  return (
    <Card className="p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Hourglass className="h-5 w-5 text-electric" />
          <h2 className="text-lg font-bold text-navy">Pending Builds</h2>
        </div>
        <Button variant="secondary" size="sm" onClick={fetchBuilds} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 text-navy/40 text-sm py-8">
          <Spinner className="h-4 w-4" /> Loading pending builds…
        </div>
      ) : builds.length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title="No pending builds"
          message="Queue a build below to track it here until components are available."
        />
      ) : (
        <Table>
          <thead>
            <Tr>
              <Th>Assembly</Th>
              <Th numeric>Qty</Th>
              <Th>Date</Th>
              <Th>Status</Th>
              <Th>Components</Th>
              <Th className="w-52"></Th>
            </Tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <Tr key={b.id}>
                <Td className="font-semibold text-navy">
                  {b.assemblyName}
                  {b.assemblySku ? <span className="ml-1 text-xs text-navy/40">({b.assemblySku})</span> : null}
                  {b.memo ? <p className="text-xs font-normal text-navy/40">{b.memo}</p> : null}
                </Td>
                <Td numeric className="tabular-nums">{parseFloat(b.quantity).toFixed(2)}</Td>
                <Td className="text-navy/60 text-sm">{formatShortDate(b.date)}</Td>
                <Td>
                  <Badge
                    tone={b.status === 'pending' ? 'warning' : b.status === 'built' ? 'success' : 'neutral'}
                  >
                    {b.status}
                  </Badge>
                </Td>
                <Td>
                  {b.status !== 'pending' ? (
                    <span className="text-navy/30 text-sm">—</span>
                  ) : b.canBuild ? (
                    <Badge tone="success">
                      <CheckCircle2 className="h-3 w-3 mr-1 inline" />
                      Ready to build
                    </Badge>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {b.components
                        .filter((c) => parseFloat(c.shortage) > 0)
                        .map((c) => (
                          <Badge key={c.componentItemId} tone="danger">
                            {c.componentName}: short {parseFloat(c.shortage).toFixed(2)}
                          </Badge>
                        ))}
                    </div>
                  )}
                </Td>
                <Td>
                  {b.status === 'pending' && (
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        disabled={!b.canBuild}
                        title={b.canBuild ? undefined : 'Blocked: insufficient component stock'}
                        onClick={() => setConfirm({ id: b.id, action: 'finalize' })}
                      >
                        <Hammer className="h-3.5 w-3.5" /> Finalize
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-400 hover:text-red-600 hover:bg-red-50"
                        onClick={() => setConfirm({ id: b.id, action: 'cancel' })}
                      >
                        <XCircle className="h-3.5 w-3.5" /> Cancel
                      </Button>
                    </div>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.action === 'finalize' ? 'Finalize Pending Build' : 'Cancel Pending Build'}
        tone={confirm?.action === 'cancel' ? 'danger' : undefined}
        confirmLabel={confirm?.action === 'finalize' ? 'Build Now' : 'Cancel Build'}
        loading={acting}
        message={
          confirm?.action === 'finalize'
            ? `Build ${confirmBuild ? parseFloat(confirmBuild.quantity).toFixed(2) : ''} unit(s) of ${confirmBuild?.assemblyName ?? 'this assembly'} now? Component stock will be consumed.`
            : `Cancel this pending build of ${confirmBuild?.assemblyName ?? 'this assembly'}? No stock will move.`
        }
        onConfirm={runAction}
        onClose={() => (acting ? undefined : setConfirm(null))}
      />
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AssembliesPage() {
  // All items list (for dropdowns)
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);

  // Selected assembly
  const [selectedAssemblyId, setSelectedAssemblyId] = useState<string>('');
  const [selectedAssembly, setSelectedAssembly] = useState<Item | null>(null);

  // BOM state
  const [bom, setBom] = useState<BomRow[]>([]);
  const [loadingBom, setLoadingBom] = useState(false);

  // Draft BOM rows for editing
  const [draftRows, setDraftRows] = useState<DraftBomRow[]>([]);
  const [savingBom, setSavingBom] = useState(false);

  // Build/unbuild
  const [buildQty, setBuildQty] = useState('1');
  const [buildAction, setBuildAction] = useState<'build' | 'unbuild'>('build');
  const [building, setBuilding] = useState(false);
  // Advanced Inventory: build site (+ bin / serials / lot of the finished assemblies).
  const adv = useAdvancedInventory(true);
  const [buildInv, setBuildInv] = useState<InvDetail>({});

  // Pending builds
  const [pendingRefresh, setPendingRefresh] = useState(0);
  const [queueing, setQueueing] = useState(false);

  // ── Data loading ───────────────────────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    setLoadingItems(true);
    try {
      const data = await api.get<{ items: Item[] }>('/api/items');
      setAllItems(data.items.filter((i) => i.isActive));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load items.', 'danger');
    } finally {
      setLoadingItems(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // Reload a single item's data (after build/unbuild)
  const refreshAssemblyItem = useCallback(async (itemId: string) => {
    try {
      const data = await api.get<{ items: Item[] }>('/api/items');
      const updated = data.items.find((i) => i.id === itemId);
      if (updated) {
        setSelectedAssembly(updated);
        setAllItems(data.items.filter((i) => i.isActive));
      }
    } catch {
      // non-critical refresh
    }
  }, []);

  const fetchBom = useCallback(async (assemblyItemId: string) => {
    setLoadingBom(true);
    try {
      const data = await api.get<{ assemblyItemId: string; components: BomRow[] }>(
        `/api/assemblies?assemblyItemId=${assemblyItemId}`,
      );
      setBom(data.components);
      setDraftRows(
        data.components.map((c) => ({
          componentItemId: c.componentItemId,
          quantity: c.quantity,
        })),
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load BOM.', 'danger');
    } finally {
      setLoadingBom(false);
    }
  }, []);

  // ── Assembly selection ─────────────────────────────────────────────────────

  function handleSelectAssembly(id: string) {
    setSelectedAssemblyId(id);
    setBom([]);
    setDraftRows([]);
    setBuildQty('1');
    if (!id) {
      setSelectedAssembly(null);
      return;
    }
    const item = allItems.find((i) => i.id === id) ?? null;
    setSelectedAssembly(item);
    fetchBom(id);
  }

  // ── Draft BOM editing ──────────────────────────────────────────────────────

  function addDraftRow() {
    setDraftRows((prev) => [...prev, { componentItemId: '', quantity: '1' }]);
  }

  function removeDraftRow(index: number) {
    setDraftRows((prev) => prev.filter((_, i) => i !== index));
  }

  function updateDraftRow(index: number, field: keyof DraftBomRow, value: string) {
    setDraftRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  async function saveBom() {
    if (!selectedAssemblyId) return;

    const validRows = draftRows.filter((r) => r.componentItemId && r.quantity);
    setSavingBom(true);
    try {
      await api.patch('/api/assemblies', {
        assemblyItemId: selectedAssemblyId,
        components: validRows,
      });
      // Re-fetch
      await fetchBom(selectedAssemblyId);
      toast('Bill of materials saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save BOM.', 'danger');
    } finally {
      setSavingBom(false);
    }
  }

  // ── Build / Unbuild ────────────────────────────────────────────────────────

  async function handleBuildAction() {
    if (!selectedAssemblyId) return;
    const qty = parseFloat(buildQty);
    if (!qty || qty <= 0) {
      toast('Quantity must be greater than zero.', 'danger');
      return;
    }

    setBuilding(true);
    try {
      await api.post('/api/assemblies/build', {
        assemblyItemId: selectedAssemblyId,
        quantity: buildQty,
        action: buildAction,
        ...inventoryLinePayload(buildInv),
      });
      const verb = buildAction === 'build' ? 'Built' : 'Unbuilt';
      toast(`${verb} ${buildQty} unit(s) of ${selectedAssembly?.name ?? 'assembly'}.`, 'success');
      await refreshAssemblyItem(selectedAssemblyId);
      // Also refresh component quantities shown in BOM table
      await fetchBom(selectedAssemblyId);
      setBuildQty('1');
      setBuildInv((p) => ({ siteId: p.siteId }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `${buildAction} failed.`, 'danger');
    } finally {
      setBuilding(false);
    }
  }

  // ── Queue pending build ────────────────────────────────────────────────────

  async function handleQueuePending() {
    if (!selectedAssemblyId) return;
    const qty = parseFloat(buildQty);
    if (!qty || qty <= 0) {
      toast('Quantity must be greater than zero.', 'danger');
      return;
    }
    setQueueing(true);
    try {
      const data = await api.post<{ build: PendingBuild }>('/api/assemblies/pending', {
        assemblyItemId: selectedAssemblyId,
        quantity: buildQty,
        date: todayISO(),
      });
      setPendingRefresh((n) => n + 1);
      toast(
        data.build.canBuild
          ? `Queued pending build of ${buildQty} unit(s) — components are available.`
          : `Queued pending build of ${buildQty} unit(s) — ${data.build.shortageCount} component(s) short.`,
        data.build.canBuild ? 'success' : 'info',
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to queue pending build.', 'danger');
    } finally {
      setQueueing(false);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Items available as components (not the assembly itself)
  const componentCandidates = allItems.filter((i) => i.id !== selectedAssemblyId);

  // BOM cost estimate (decimal-safe — never float math for money)
  const estimatedCost = draftRows.reduce((sum, row) => {
    const comp = allItems.find((i) => i.id === row.componentItemId);
    if (!comp || !comp.averageCost) return sum;
    return sum.plus(Money.mul(comp.averageCost, row.quantity || '0'));
  }, Money.zero());

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Inventory Assemblies" icon={Combine} />

      {/* Assembly selector */}
      <Card className="p-6 mb-6">
        <div className="max-w-md">
          <Label htmlFor="asm-select">Select Assembly Item</Label>
          {loadingItems ? (
            <div className="flex items-center gap-2 text-navy/40 text-sm py-2">
              <Spinner className="h-4 w-4" /> Loading items…
            </div>
          ) : (
            <Select
              id="asm-select"
              value={selectedAssemblyId}
              onChange={(e) => handleSelectAssembly(e.target.value)}
            >
              <option value="">— Pick an item —</option>
              {allItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.sku ? ` (${item.sku})` : ''}
                  {' — '}
                  {item.type}
                </option>
              ))}
            </Select>
          )}
          {selectedAssembly && (
            <div className="mt-3 flex items-center gap-4 text-sm text-navy/60">
              <span>
                On hand:{' '}
                <span className="font-semibold text-navy">
                  {formatQty(selectedAssembly.quantityOnHand)}
                </span>
              </span>
              <span>
                Avg cost:{' '}
                <span className="font-semibold text-navy">
                  {selectedAssembly.averageCost
                    ? formatCurrency(selectedAssembly.averageCost)
                    : '—'}
                </span>
              </span>
              <Badge tone="info">{selectedAssembly.type}</Badge>
            </div>
          )}
        </div>
      </Card>

      {/* Pending builds (always visible) */}
      <PendingBuildsSection
        refreshKey={pendingRefresh}
        onStockChanged={() => {
          fetchItems();
          if (selectedAssemblyId) {
            refreshAssemblyItem(selectedAssemblyId);
            fetchBom(selectedAssemblyId);
          }
        }}
      />

      {selectedAssemblyId && (
        <>
          {/* BOM Editor */}
          <Card className="p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-navy">Bill of Materials</h2>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={addDraftRow}>
                  <Plus className="h-4 w-4" /> Add Component
                </Button>
                <Button size="sm" onClick={saveBom} loading={savingBom}>
                  Save BOM
                </Button>
              </div>
            </div>

            {loadingBom ? (
              <div className="flex items-center justify-center gap-2 text-navy/40 text-sm py-8">
                <Spinner className="h-4 w-4" /> Loading BOM…
              </div>
            ) : draftRows.length === 0 ? (
              <EmptyState
                icon={Layers}
                title="No components yet"
                message="Define the bill of materials by adding the component items this assembly is built from."
                action={
                  <Button variant="secondary" onClick={addDraftRow}>
                    <Plus className="h-4 w-4" /> Add Component
                  </Button>
                }
              />
            ) : (
              <>
                <Table>
                  <thead>
                    <tr>
                      <Th>Component Item</Th>
                      <Th className="w-36">Qty per Assembly</Th>
                      <Th numeric>Unit Cost</Th>
                      <Th numeric>On Hand</Th>
                      <Th className="w-12"></Th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftRows.map((row, idx) => {
                      const comp = allItems.find((i) => i.id === row.componentItemId);
                      return (
                        <Tr key={idx}>
                          <Td>
                            <Select
                              value={row.componentItemId}
                              onChange={(e) => updateDraftRow(idx, 'componentItemId', e.target.value)}
                            >
                              <option value="">— Select item —</option>
                              {componentCandidates.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                  {item.sku ? ` (${item.sku})` : ''}
                                </option>
                              ))}
                            </Select>
                          </Td>
                          <Td>
                            <Input
                              type="number"
                              min="0.0001"
                              step="0.0001"
                              value={row.quantity}
                              onChange={(e) => updateDraftRow(idx, 'quantity', e.target.value)}
                            />
                          </Td>
                          <Td numeric className="text-sm">
                            {comp?.averageCost ? formatCurrency(comp.averageCost) : '—'}
                          </Td>
                          <Td numeric className="text-sm">
                            {comp?.quantityOnHand ? formatQty(comp.quantityOnHand) : '—'}
                          </Td>
                          <Td>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeDraftRow(idx)}
                              className="text-red-400 hover:text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
                <div className="mt-4 flex items-center justify-end gap-2 text-sm text-navy/60">
                  <span>Estimated cost per assembly:</span>
                  <span className="font-bold text-navy tabular-nums">
                    {formatCurrency(estimatedCost)}
                  </span>
                </div>
              </>
            )}
          </Card>

          {/* Build / Unbuild Panel */}
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <Hammer className="h-5 w-5 text-electric" />
              <h2 className="text-lg font-bold text-navy">Build / Unbuild</h2>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <div className="w-40">
                <Label htmlFor="build-action">Action</Label>
                <Select
                  id="build-action"
                  value={buildAction}
                  onChange={(e) => setBuildAction(e.target.value as 'build' | 'unbuild')}
                >
                  <option value="build">Build</option>
                  <option value="unbuild">Unbuild</option>
                </Select>
              </div>

              <div className="w-40">
                <Label htmlFor="build-qty">Quantity</Label>
                <Input
                  id="build-qty"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  value={buildQty}
                  onChange={(e) => setBuildQty(e.target.value)}
                />
              </div>

              {selectedAssembly && (
                <InventoryLineFields
                  className="w-full"
                  adv={adv}
                  item={selectedAssembly}
                  quantity={buildQty}
                  direction={buildAction === 'build' ? 'in' : 'out'}
                  value={buildInv}
                  onChange={setBuildInv}
                />
              )}

              <Button onClick={handleBuildAction} loading={building} disabled={bom.length === 0}>
                <Hammer className="h-4 w-4" />
                {buildAction === 'build' ? 'Build Assembly' : 'Unbuild Assembly'}
              </Button>

              {buildAction === 'build' && (
                <Button
                  variant="secondary"
                  onClick={handleQueuePending}
                  loading={queueing}
                  disabled={bom.length === 0}
                  title="Save this build as pending — finalize later when components are in stock"
                >
                  <Hourglass className="h-4 w-4" />
                  Queue as Pending
                </Button>
              )}
            </div>

            {bom.length === 0 && (
              <p className="mt-3 text-sm text-navy/40">
                Save a bill of materials above before building.
              </p>
            )}

            {bom.length > 0 && buildAction === 'build' && (
              <div className="mt-4 rounded-lg bg-navy/5 p-4 text-sm text-navy/70">
                <p className="font-semibold text-navy mb-2">What will happen:</p>
                <ul className="space-y-1">
                  {bom.map((row) => {
                    const consumed = parseFloat(row.quantity) * parseFloat(buildQty || '0');
                    return (
                      <li key={row.id}>
                        Consume{' '}
                        <span className="font-semibold text-navy">{formatQty(consumed)}</span>{' '}
                        unit(s) of{' '}
                        <span className="font-semibold text-navy">{row.componentName}</span>
                      </li>
                    );
                  })}
                  <li className="pt-1 border-t border-navy/10 mt-1">
                    Produce{' '}
                    <span className="font-semibold text-navy">{formatQty(buildQty || '0')}</span>{' '}
                    unit(s) of{' '}
                    <span className="font-semibold text-navy">{selectedAssembly?.name}</span>
                  </li>
                </ul>
                <p className="mt-3 text-xs text-navy/40">
                  No GL journal entry is posted — both sides are account 1300 (net $0).
                  Quantities and average cost are updated directly on the item records.
                </p>
              </div>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
