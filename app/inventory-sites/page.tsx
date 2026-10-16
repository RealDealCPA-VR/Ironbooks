'use client';

/**
 * Inventory Sites — QB Desktop Enterprise Advanced Inventory setup and day-to-day tools:
 *   Sites & Bins        create/rename sites, pick the default site, manage bins per site
 *   Adjust Quantity     add/remove stock at a site/bin with serial or lot numbers
 *   Reorder Points      per-site reorder point and max level for an item
 *   Self-check          sites add up to on hand, serials unique, inventory GL == valuation
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRightLeft,
  BadgeCheck,
  ClipboardEdit,
  MapPin,
  Plus,
  ShieldCheck,
  Star,
  Target,
  Warehouse,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
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
import { todayISO } from '@/lib/dates';
import {
  type AdjustmentFieldValues,
  EMPTY_ADJUSTMENT_FIELDS,
  InventoryAdjustmentFields,
  adjustmentPayload,
} from '@/components/InventoryAdjustmentFields';
import { formatCurrency } from '@/lib/money';
import {
  InventoryLineFields,
  type InvDetail,
  inventoryLinePayload,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Site {
  id: string;
  name: string;
  code: string | null;
  notes: string | null;
  isDefault: boolean;
  isActive: boolean;
}

interface Bin {
  id: string;
  siteId: string;
  name: string;
  isActive: boolean;
}

interface SiteTotals {
  id: string;
  totalQuantity: string;
  totalValue: string;
}

interface Item {
  id: string;
  name: string;
  type: string;
  trackingMode?: string | null;
  purchaseCost?: string | null;
  quantityOnHand?: string | null;
}

interface ReorderSetting {
  itemId: string;
  siteId: string;
  reorderPoint: string | null;
  maxQuantity: string | null;
}

interface InvariantCheck {
  name: string;
  ok: boolean;
  detail: string;
}

type Tab = 'sites' | 'adjust' | 'reorder' | 'check';

const today = () => todayISO();
const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InventorySitesPage() {
  const [tab, setTab] = useState<Tab>('sites');
  const [sites, setSites] = useState<Site[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [totals, setTotals] = useState<Map<string, SiteTotals>>(new Map());
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [siteRows, binRows, qoh] = await Promise.all([
        api.get<Site[]>('/api/inventory-sites?includeInactive=1'),
        api.get<Bin[]>('/api/inventory-sites/bins?includeInactive=1'),
        api.get<{ sites: SiteTotals[] }>('/api/inventory-sites/reports?report=qoh'),
      ]);
      setSites(siteRows);
      setBins(binRows);
      setTotals(new Map(qoh.sites.map((s) => [s.id, s])));
    } catch (err) {
      toast(errMsg(err, 'Failed to load sites.'), 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .get<{ items: Item[] }>('/api/items?type=inventory')
      .then((d) => setItems((d.items ?? []).filter((i) => i.type === 'inventory')))
      .catch(() => undefined);
  }, [refresh]);

  const tabs: Array<{ id: Tab; label: string; icon: typeof Warehouse }> = [
    { id: 'sites', label: 'Sites & Bins', icon: Warehouse },
    { id: 'adjust', label: 'Adjust Quantity', icon: ClipboardEdit },
    { id: 'reorder', label: 'Reorder Points', icon: Target },
    { id: 'check', label: 'Self-check', icon: ShieldCheck },
  ];

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Inventory Sites"
        icon={Warehouse}
        action={
          <div className="flex gap-2">
            <Link href="/inventory-transfers">
              <Button variant="secondary">
                <ArrowRightLeft className="h-4 w-4" /> Transfer Inventory
              </Button>
            </Link>
            <Link href="/reports/inventory-sites">
              <Button variant="secondary">
                <MapPin className="h-4 w-4" /> Reports by Site
              </Button>
            </Link>
          </div>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Track where your stock is: warehouses, stores, trucks. Every invoice, receipt and bill line can
        name a site (and bin); lines without one use the <strong>default site</strong>. Costs stay per
        item, so sites never change your books — the site quantities always add up to quantity on hand.
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.id ? 'bg-navy text-white shadow' : 'bg-white/70 text-navy/60 hover:bg-white hover:text-navy'
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8 text-electric" />
        </div>
      ) : (
        <>
          {tab === 'sites' && <SitesTab sites={sites} bins={bins} totals={totals} onChanged={refresh} />}
          {tab === 'adjust' && <AdjustTab items={items} onDone={refresh} />}
          {tab === 'reorder' && <ReorderTab items={items} sites={sites.filter((s) => s.isActive)} />}
          {tab === 'check' && <CheckTab />}
        </>
      )}
    </main>
  );
}

// ── Sites & Bins ──────────────────────────────────────────────────────────────

function SitesTab({
  sites,
  bins,
  totals,
  onChanged,
}: {
  sites: Site[];
  bins: Bin[];
  totals: Map<string, SiteTotals>;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Site | 'new' | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [newBin, setNewBin] = useState<Record<string, string>>({});

  function openEditor(site: Site | 'new') {
    setEditing(site);
    setName(site === 'new' ? '' : site.name);
    setCode(site === 'new' ? '' : (site.code ?? ''));
    setNotes(site === 'new' ? '' : (site.notes ?? ''));
  }

  async function save() {
    if (!name.trim()) {
      toast('Enter a site name.', 'danger');
      return;
    }
    setSaving(true);
    try {
      if (editing === 'new') {
        await api.post('/api/inventory-sites', { name, code: code || null, notes: notes || null });
        toast('Site created.', 'success');
      } else if (editing) {
        await api.patch(`/api/inventory-sites/${editing.id}`, { name, code: code || null, notes: notes || null });
        toast('Site updated.', 'success');
      }
      setEditing(null);
      await onChanged();
    } catch (err) {
      toast(errMsg(err, 'Failed to save site.'), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function patchSite(site: Site, body: Record<string, unknown>, ok: string) {
    try {
      await api.patch(`/api/inventory-sites/${site.id}`, body);
      toast(ok, 'success');
      await onChanged();
    } catch (err) {
      toast(errMsg(err, 'Failed to update site.'), 'danger');
    }
  }

  async function addBin(siteId: string) {
    const binName = (newBin[siteId] ?? '').trim();
    if (!binName) return;
    try {
      await api.post('/api/inventory-sites/bins', { siteId, name: binName });
      setNewBin((p) => ({ ...p, [siteId]: '' }));
      await onChanged();
    } catch (err) {
      toast(errMsg(err, 'Failed to add bin.'), 'danger');
    }
  }

  async function toggleBin(bin: Bin) {
    try {
      await api.patch(`/api/inventory-sites/bins/${bin.id}`, { isActive: !bin.isActive });
      await onChanged();
    } catch (err) {
      toast(errMsg(err, 'Failed to update bin.'), 'danger');
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => openEditor('new')}>
          <Plus className="h-4 w-4" /> New Site
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {sites.map((site) => {
          const t = totals.get(site.id);
          const siteBins = bins.filter((b) => b.siteId === site.id);
          return (
            <Card key={site.id} className={`p-5 ${site.isActive ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-lg font-bold text-navy">
                    {site.name}
                    {site.code && <span className="text-sm font-normal text-navy/40">{site.code}</span>}
                    {site.isDefault && <Badge tone="info">Default</Badge>}
                    {!site.isActive && <Badge tone="neutral">Inactive</Badge>}
                  </h3>
                  {site.notes && <p className="text-sm text-navy/50">{site.notes}</p>}
                  <p className="mt-1 text-sm text-navy/60">
                    {Number(t?.totalQuantity ?? 0).toLocaleString('en-US')} units on hand ·{' '}
                    {formatCurrency(t?.totalValue ?? '0')}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openEditor(site)}>
                    Edit
                  </Button>
                  {!site.isDefault && site.isActive && (
                    <Button size="sm" variant="ghost" onClick={() => patchSite(site, { isDefault: true }, `${site.name} is now the default site.`)}>
                      <Star className="h-4 w-4" /> Make default
                    </Button>
                  )}
                  {!site.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        patchSite(site, { isActive: !site.isActive }, site.isActive ? 'Site made inactive.' : 'Site reactivated.')
                      }
                    >
                      {site.isActive ? 'Make inactive' : 'Reactivate'}
                    </Button>
                  )}
                </div>
              </div>
              <div className="mt-4">
                <Label className="mb-1">Bins</Label>
                <div className="flex flex-wrap gap-2">
                  {siteBins.length === 0 && <span className="text-sm text-navy/40">No bins — stock is tracked at the site level.</span>}
                  {siteBins.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => toggleBin(b)}
                      title={b.isActive ? 'Click to make inactive' : 'Click to reactivate'}
                      className={`rounded-lg px-2 py-1 text-xs font-semibold ring-1 ${
                        b.isActive ? 'bg-white text-navy ring-slate-200 hover:ring-electric' : 'bg-slate-100 text-navy/40 line-through ring-slate-100'
                      }`}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
                {site.isActive && (
                  <div className="mt-2 flex gap-2">
                    <Input
                      className="h-8 w-40 py-0 text-xs"
                      placeholder="New bin (e.g. A-01)"
                      value={newBin[site.id] ?? ''}
                      onChange={(e) => setNewBin((p) => ({ ...p, [site.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void addBin(site.id);
                        }
                      }}
                    />
                    <Button size="sm" variant="secondary" onClick={() => addBin(site.id)}>
                      Add bin
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New Inventory Site' : 'Edit Site'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label htmlFor="site-name">Site name *</Label>
            <Input id="site-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. East Warehouse" />
          </div>
          <div>
            <Label htmlFor="site-code">Short code</Label>
            <Input id="site-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Optional, e.g. EW" />
          </div>
          <div>
            <Label htmlFor="site-notes">Notes / address</Label>
            <Input id="site-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
        </div>
      </Modal>
    </>
  );
}

// ── Adjust quantity at a site ─────────────────────────────────────────────────

function AdjustTab({ items, onDone }: { items: Item[]; onDone: () => Promise<void> }) {
  const adv = useAdvancedInventory(true);
  const [itemId, setItemId] = useState('');
  const [change, setChange] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [inv, setInv] = useState<InvDetail>({});
  const [adjFields, setAdjFields] = useState<AdjustmentFieldValues>(EMPTY_ADJUSTMENT_FIELDS);
  const [saving, setSaving] = useState(false);

  const item = items.find((i) => i.id === itemId);
  const adding = Number(change) > 0;
  // Always show the site picker here, even for single-site companies.
  const advForForm = { ...adv, multiSite: adv.sites.length > 0 };

  async function submit() {
    if (!itemId) return toast('Choose an item.', 'danger');
    if (!change || Number(change) === 0) return toast('Enter the quantity to add (+) or remove (−).', 'danger');
    if (adding && unitCost === '') return toast('Enter the unit cost of the stock you are adding.', 'danger');
    setSaving(true);
    try {
      await api.post('/api/inventory-sites/adjust', {
        itemId,
        quantityChange: change,
        unitCost: adding ? unitCost : null,
        date,
        memo: memo || null,
        ...adjustmentPayload(adjFields),
        ...inventoryLinePayload(inv),
      });
      toast('Inventory adjusted.', 'success');
      setChange('');
      setMemo('');
      setInv((p) => ({ siteId: p.siteId, binId: p.binId }));
      await onDone();
    } catch (err) {
      toast(errMsg(err, 'Adjustment failed.'), 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-3xl space-y-4 p-6">
      <p className="text-sm text-navy/60">
        Add or remove stock at a specific site and bin (damage, found stock, opening counts). The change in
        inventory value goes to the adjustment account you pick (Inventory Adjustments unless you choose
        another): adds at the cost you enter, removals at the item&apos;s current cost.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="adj-item">Item *</Label>
          <Select
            id="adj-item"
            value={itemId}
            onChange={(e) => {
              setItemId(e.target.value);
              const next = items.find((i) => i.id === e.target.value);
              setUnitCost(next?.purchaseCost ?? '');
              setInv((p) => ({ siteId: p.siteId }));
            }}
          >
            <option value="">Choose an inventory item…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({Number(i.quantityOnHand ?? 0)} on hand)
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="adj-date">Date *</Label>
          <DateInput id="adj-date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="adj-qty">Quantity change * (+ add, − remove)</Label>
          <Input id="adj-qty" type="number" step="any" value={change} onChange={(e) => setChange(e.target.value)} placeholder="e.g. 5 or -2" />
        </div>
        {adding && (
          <div>
            <Label htmlFor="adj-cost">Unit cost *</Label>
            <Input id="adj-cost" type="number" min="0" step="any" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </div>
        )}
      </div>
      {item && (
        <InventoryLineFields
          adv={advForForm}
          item={item}
          quantity={Math.abs(Number(change) || 0)}
          direction={adding ? 'in' : 'out'}
          value={inv}
          onChange={setInv}
        />
      )}
      <InventoryAdjustmentFields value={adjFields} onChange={setAdjFields} idPrefix="adj-site" />
      <div>
        <Label htmlFor="adj-memo">Reason / memo</Label>
        <Input id="adj-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Damaged in transit" />
      </div>
      <div className="flex justify-end">
        <Button onClick={submit} loading={saving}>
          Record Adjustment
        </Button>
      </div>
    </Card>
  );
}

// ── Per-site reorder points ───────────────────────────────────────────────────

function ReorderTab({ items, sites }: { items: Item[]; sites: Site[] }) {
  const [itemId, setItemId] = useState('');
  const [values, setValues] = useState<Record<string, { reorderPoint: string; maxQuantity: string }>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!itemId) return;
    api
      .get<ReorderSetting[]>(`/api/inventory-sites/reorder-points?itemId=${itemId}`)
      .then((rows) => {
        const next: Record<string, { reorderPoint: string; maxQuantity: string }> = {};
        for (const s of sites) {
          const r = rows.find((x) => x.siteId === s.id);
          next[s.id] = {
            reorderPoint: r?.reorderPoint != null ? String(Number(r.reorderPoint)) : '',
            maxQuantity: r?.maxQuantity != null ? String(Number(r.maxQuantity)) : '',
          };
        }
        setValues(next);
      })
      .catch((err) => toast(errMsg(err, 'Failed to load reorder points.'), 'danger'));
  }, [itemId, sites]);

  async function save() {
    setSaving(true);
    try {
      for (const s of sites) {
        const v = values[s.id] ?? { reorderPoint: '', maxQuantity: '' };
        await api.put('/api/inventory-sites/reorder-points', {
          itemId,
          siteId: s.id,
          reorderPoint: v.reorderPoint,
          maxQuantity: v.maxQuantity,
        });
      }
      toast('Reorder points saved.', 'success');
    } catch (err) {
      toast(errMsg(err, 'Failed to save reorder points.'), 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-3xl p-6">
      <p className="mb-4 text-sm text-navy/60">
        Each site can have its own reorder point. When a site&apos;s available stock falls to its reorder
        point it appears on the <Link className="text-electric underline" href="/reports/inventory-sites">Reorder by Site</Link>{' '}
        report, with a suggested order up to the max level (or twice the reorder point).
      </p>
      <div className="mb-4 w-80">
        <Label htmlFor="rp-item">Item</Label>
        <Select id="rp-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
          <option value="">Choose an inventory item…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      </div>
      {itemId && (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Site</Th>
                <Th numeric>Reorder point</Th>
                <Th numeric>Max level</Th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    {s.name}
                    {s.isDefault && (
                      <Badge tone="info" className="ml-2">
                        Default
                      </Badge>
                    )}
                  </Td>
                  <Td numeric>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      className="ml-auto w-28 text-right"
                      value={values[s.id]?.reorderPoint ?? ''}
                      onChange={(e) =>
                        setValues((p) => ({ ...p, [s.id]: { ...(p[s.id] ?? { maxQuantity: '' }), reorderPoint: e.target.value } }))
                      }
                    />
                  </Td>
                  <Td numeric>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      className="ml-auto w-28 text-right"
                      value={values[s.id]?.maxQuantity ?? ''}
                      onChange={(e) =>
                        setValues((p) => ({ ...p, [s.id]: { ...(p[s.id] ?? { reorderPoint: '' }), maxQuantity: e.target.value } }))
                      }
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4 flex justify-end">
            <Button onClick={save} loading={saving}>
              Save Reorder Points
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// ── Self-check ────────────────────────────────────────────────────────────────

function CheckTab() {
  const [checks, setChecks] = useState<InvariantCheck[] | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      const res = await api.get<{ checks: InvariantCheck[] }>('/api/inventory-sites/reports?report=invariants');
      setChecks(res.checks);
    } catch (err) {
      toast(errMsg(err, 'Self-check failed to run.'), 'danger');
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    void run();
  }, []);

  return (
    <Card className="max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-navy/60">Verifies that inventory by site, serial/lot numbers and the general ledger all agree.</p>
        <Button variant="secondary" onClick={run} loading={running}>
          Run again
        </Button>
      </div>
      {!checks ? (
        <EmptyState icon={ShieldCheck} title="Running checks…" />
      ) : (
        <ul className="space-y-2">
          {checks.map((c) => (
            <li key={c.name} className="flex items-start gap-3 rounded-lg border border-slate-100 p-3">
              <BadgeCheck className={`mt-0.5 h-5 w-5 shrink-0 ${c.ok ? 'text-emerald' : 'text-red-500'}`} />
              <div>
                <p className="font-semibold text-navy">
                  {c.name}{' '}
                  <Badge tone={c.ok ? 'success' : 'danger'} className="ml-1">
                    {c.ok ? 'OK' : 'Attention'}
                  </Badge>
                </p>
                <p className="text-sm text-navy/60">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
