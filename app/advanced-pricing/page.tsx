'use client';

/**
 * Advanced Pricing (QB Enterprise parity): price rules, price levels, customer assignments,
 * customer / vendor type lists, pricing preferences, and a "price check" that runs the same
 * server-side engine the sales forms use.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgePercent, Pencil, Plus, Trash2, Search, ListTree, Settings2, Users, Layers } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
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
import {
  ROUNDING_LABELS,
  ROUNDING_MODES,
  type PriceAdjustment,
  type PriceQuote,
  type PriceRuleConditions,
  type PriceTier,
  type RoundingMode,
} from '@/lib/pricingShared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Item {
  id: string;
  name: string;
  type: string;
  salesPrice: string | null;
  purchaseCost: string | null;
  isActive: boolean;
}
interface Customer {
  id: string;
  displayName: string;
  parentId: string | null;
  customerTypeId: string | null;
  priceLevelId: string | null;
  isActive: boolean;
}
interface Vendor {
  id: string;
  displayName: string;
  vendorTypeId: string | null;
  isActive: boolean;
}
interface Named {
  id: string;
  name: string;
}
interface TypeRow {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
}
interface PriceLevel {
  id: string;
  name: string;
  type: 'fixed_percent' | 'per_item';
  percent: string;
  rounding: RoundingMode;
  isActive: boolean;
  customerCount: number;
  items: Array<{ itemId: string; price: string }>;
}
interface PriceRule {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  priority: number;
  conditions: PriceRuleConditions;
  adjustment: PriceAdjustment;
  tiers: PriceTier[] | null;
  rounding: RoundingMode | null;
  startDate: string | null;
  endDate: string | null;
  minQuantity: string | null;
}
interface PricingSettings {
  enabled: boolean;
  conflictMode: 'lowest' | 'priority';
  defaultRounding: RoundingMode;
}

const PRICEABLE_TYPES = [
  { value: 'service', label: 'Service' },
  { value: 'inventory', label: 'Inventory part' },
  { value: 'non_inventory', label: 'Non-inventory part' },
  { value: 'bundle', label: 'Group / bundle' },
  { value: 'other_charge', label: 'Other charge' },
];

type Tab = 'rules' | 'levels' | 'customers' | 'types' | 'preferences';

function errMsg(err: unknown, fallback: string) {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

function describeAdjustment(a: PriceAdjustment): string {
  if (!a) return '—';
  if (a.method === 'fixed') return `Fixed ${formatCurrency(a.value)}`;
  const amt = a.method === 'percent' ? `${Number(a.value)}%` : formatCurrency(a.value);
  return `${a.direction === 'increase' ? '+' : '−'}${amt} from ${a.basis === 'cost' ? 'cost' : 'price'}`;
}

// ---------------------------------------------------------------------------
// Reusable pickers
// ---------------------------------------------------------------------------

/** Checkbox list with a filter box (for rule conditions). Empty selection = "any". */
function MultiPick({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; name: string }>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const shown = options.filter((o) => o.name.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label className="mb-1">{label}</Label>
        <span className="text-[11px] text-navy/40">{value.length === 0 ? 'Any' : `${value.length} selected`}</span>
      </div>
      {options.length > 8 && (
        <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-1 py-1" />
      )}
      <div className="max-h-28 overflow-y-auto rounded-lg border border-slate-200 px-2 py-1">
        {shown.length === 0 && <p className="text-xs text-navy/40 py-1">Nothing to choose.</p>}
        {shown.map((o) => (
          <label key={o.id} className="flex items-center gap-2 py-0.5 text-sm text-navy cursor-pointer">
            <input type="checkbox" className="accent-electric" checked={value.includes(o.id)} onChange={() => toggle(o.id)} />
            {o.name}
          </label>
        ))}
      </div>
    </div>
  );
}

function AdjustmentFields({
  value,
  onChange,
  compact = false,
}: {
  value: PriceAdjustment;
  onChange: (v: PriceAdjustment) => void;
  compact?: boolean;
}) {
  const fixed = value.method === 'fixed';
  return (
    <div className={compact ? 'flex flex-wrap gap-2' : 'grid grid-cols-2 gap-2 sm:grid-cols-4'}>
      <Select value={value.method} onChange={(e) => onChange({ ...value, method: e.target.value as PriceAdjustment['method'] })} aria-label="Adjustment type">
        <option value="percent">Percent</option>
        <option value="amount">Amount</option>
        <option value="fixed">Fixed price</option>
      </Select>
      {!fixed && (
        <Select value={value.direction} onChange={(e) => onChange({ ...value, direction: e.target.value as PriceAdjustment['direction'] })} aria-label="Direction">
          <option value="decrease">Decrease</option>
          <option value="increase">Increase</option>
        </Select>
      )}
      {!fixed && (
        <Select value={value.basis} onChange={(e) => onChange({ ...value, basis: e.target.value as PriceAdjustment['basis'] })} aria-label="Based on">
          <option value="price">from base price</option>
          <option value="cost">from cost</option>
        </Select>
      )}
      <Input
        type="number"
        min="0"
        step="any"
        value={value.value}
        placeholder={value.method === 'percent' ? '%' : '0.00'}
        onChange={(e) => onChange({ ...value, value: e.target.value })}
        aria-label="Adjustment value"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule editor
// ---------------------------------------------------------------------------

interface RuleDraft {
  name: string;
  description: string;
  isActive: boolean;
  priority: string;
  adjustment: PriceAdjustment;
  tiers: PriceTier[];
  rounding: '' | RoundingMode;
  startDate: string;
  endDate: string;
  minQuantity: string;
  conditions: Required<Omit<PriceRuleConditions, 'itemCustomField'>> & { cfName: string; cfValue: string };
}

const NEW_ADJ: PriceAdjustment = { basis: 'price', method: 'percent', direction: 'decrease', value: '' };

function draftFrom(rule: PriceRule | null): RuleDraft {
  const c = rule?.conditions ?? {};
  return {
    name: rule?.name ?? '',
    description: rule?.description ?? '',
    isActive: rule?.isActive ?? true,
    priority: String(rule?.priority ?? 100),
    adjustment: rule?.adjustment ?? { ...NEW_ADJ },
    tiers: rule?.tiers ?? [],
    rounding: rule?.rounding ?? '',
    startDate: rule?.startDate ?? '',
    endDate: rule?.endDate ?? '',
    minQuantity: rule?.minQuantity ? String(Number(rule.minQuantity)) : '',
    conditions: {
      itemIds: c.itemIds ?? [],
      itemTypes: c.itemTypes ?? [],
      customerIds: c.customerIds ?? [],
      customerTypeIds: c.customerTypeIds ?? [],
      jobIds: c.jobIds ?? [],
      classIds: c.classIds ?? [],
      salesRepIds: c.salesRepIds ?? [],
      cfName: c.itemCustomField?.name ?? '',
      cfValue: c.itemCustomField?.value ?? '',
    },
  };
}

function RuleModal({
  open,
  rule,
  onClose,
  onSaved,
  lookups,
}: {
  open: boolean;
  rule: PriceRule | null;
  onClose: () => void;
  onSaved: () => void;
  lookups: Lookups;
}) {
  const [d, setD] = useState<RuleDraft>(() => draftFrom(rule));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setD(draftFrom(rule));
  }, [open, rule]);

  const setCond = (patch: Partial<RuleDraft['conditions']>) => setD((p) => ({ ...p, conditions: { ...p.conditions, ...patch } }));

  async function save() {
    if (!d.name.trim()) return toast('Give the rule a name.', 'danger');
    if (d.adjustment.value === '' || Number(d.adjustment.value) < 0) return toast('Enter the adjustment amount.', 'danger');
    const { cfName, cfValue, ...lists } = d.conditions;
    const body = {
      name: d.name.trim(),
      description: d.description.trim() || null,
      isActive: d.isActive,
      priority: Math.max(0, Math.floor(Number(d.priority) || 0)),
      adjustment: d.adjustment,
      tiers: d.tiers.filter((t) => t.minQuantity !== '' && t.adjustment.value !== ''),
      rounding: d.rounding || null,
      startDate: d.startDate || null,
      endDate: d.endDate || null,
      minQuantity: d.minQuantity || null,
      conditions: { ...lists, itemCustomField: cfName.trim() ? { name: cfName.trim(), value: cfValue } : null },
    };
    setSaving(true);
    try {
      if (rule) await api.put(`/api/pricing/rules/${rule.id}`, body);
      else await api.post('/api/pricing/rules', body);
      toast(rule ? 'Price rule updated.' : 'Price rule created.', 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(errMsg(err, 'Failed to save the price rule.'), 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule ? `Edit price rule — ${rule.name}` : 'New price rule'}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving}>Save rule</Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Label htmlFor="rule-name">Rule name *</Label>
            <Input id="rule-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus />
          </div>
          <div>
            <Label htmlFor="rule-priority">Priority</Label>
            <Input id="rule-priority" type="number" min="0" value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value })} />
            <p className="mt-0.5 text-[11px] text-navy/40">Lower number wins in “priority” mode.</p>
          </div>
          <label className="flex items-center gap-2 pt-6 text-sm text-navy">
            <input type="checkbox" className="accent-electric" checked={d.isActive} onChange={(e) => setD({ ...d, isActive: e.target.checked })} />
            Active
          </label>
          <div className="sm:col-span-4">
            <Label htmlFor="rule-desc">Description</Label>
            <Input id="rule-desc" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
          </div>
        </div>

        <section>
          <h3 className="text-sm font-bold text-navy mb-2">Price adjustment</h3>
          <AdjustmentFields value={d.adjustment} onChange={(adjustment) => setD({ ...d, adjustment })} />
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <Label htmlFor="rule-rounding">Rounding</Label>
              <Select id="rule-rounding" value={d.rounding} onChange={(e) => setD({ ...d, rounding: e.target.value as RuleDraft['rounding'] })}>
                <option value="">Company default</option>
                {ROUNDING_MODES.map((m) => (
                  <option key={m} value={m}>{ROUNDING_LABELS[m]}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="rule-start">Start date</Label>
              <Input id="rule-start" type="date" value={d.startDate} onChange={(e) => setD({ ...d, startDate: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="rule-end">End date</Label>
              <Input id="rule-end" type="date" value={d.endDate} onChange={(e) => setD({ ...d, endDate: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="rule-minqty">Minimum quantity</Label>
              <Input id="rule-minqty" type="number" min="0" step="any" value={d.minQuantity} onChange={(e) => setD({ ...d, minQuantity: e.target.value })} />
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-navy">Quantity discount tiers</h3>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setD({ ...d, tiers: [...d.tiers, { minQuantity: '', adjustment: { ...NEW_ADJ } }] })}
            >
              <Plus className="h-3.5 w-3.5" /> Add tier
            </Button>
          </div>
          {d.tiers.length === 0 ? (
            <p className="text-xs text-navy/50">No tiers — the adjustment above applies at every quantity.</p>
          ) : (
            <div className="space-y-2">
              {d.tiers.map((t, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2">
                  <span className="text-xs text-navy/60">Qty ≥</span>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    className="w-24"
                    value={t.minQuantity}
                    onChange={(e) => setD({ ...d, tiers: d.tiers.map((x, j) => (j === i ? { ...x, minQuantity: e.target.value } : x)) })}
                    aria-label="Tier minimum quantity"
                  />
                  <div className="flex-1">
                    <AdjustmentFields
                      compact
                      value={t.adjustment}
                      onChange={(adjustment) => setD({ ...d, tiers: d.tiers.map((x, j) => (j === i ? { ...x, adjustment } : x)) })}
                    />
                  </div>
                  <button
                    type="button"
                    className="text-red-400 hover:text-red-600"
                    onClick={() => setD({ ...d, tiers: d.tiers.filter((_, j) => j !== i) })}
                    aria-label="Remove tier"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-sm font-bold text-navy mb-1">Applies when… </h3>
          <p className="text-xs text-navy/50 mb-3">Leave a list empty to match anything. Every list you fill in must match.</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <MultiPick label="Items" options={lookups.items} value={d.conditions.itemIds} onChange={(itemIds) => setCond({ itemIds })} />
            <MultiPick
              label="Item types"
              options={PRICEABLE_TYPES.map((t) => ({ id: t.value, name: t.label }))}
              value={d.conditions.itemTypes}
              onChange={(itemTypes) => setCond({ itemTypes })}
            />
            <div>
              <Label className="mb-1">Item custom field</Label>
              <Input placeholder="Field name" value={d.conditions.cfName} onChange={(e) => setCond({ cfName: e.target.value })} className="mb-1" />
              <Input placeholder="Equals value" value={d.conditions.cfValue} onChange={(e) => setCond({ cfValue: e.target.value })} />
            </div>
            <MultiPick label="Customers (incl. their jobs)" options={lookups.customers} value={d.conditions.customerIds} onChange={(customerIds) => setCond({ customerIds })} />
            <MultiPick label="Customer types" options={lookups.customerTypes} value={d.conditions.customerTypeIds} onChange={(customerTypeIds) => setCond({ customerTypeIds })} />
            <MultiPick label="Jobs" options={lookups.jobs} value={d.conditions.jobIds} onChange={(jobIds) => setCond({ jobIds })} />
            <MultiPick label="Classes" options={lookups.classes} value={d.conditions.classIds} onChange={(classIds) => setCond({ classIds })} />
            <MultiPick label="Sales reps" options={lookups.salesReps} value={d.conditions.salesRepIds} onChange={(salesRepIds) => setCond({ salesRepIds })} />
          </div>
        </section>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

interface Lookups {
  items: Named[];
  customers: Named[];
  customerTypes: Named[];
  jobs: Named[];
  classes: Named[];
  salesReps: Named[];
}

function summarizeConditions(c: PriceRuleConditions, lookups: Lookups): string {
  const parts: string[] = [];
  const names = (ids: string[] | undefined, list: Named[], what: string) => {
    if (!ids || ids.length === 0) return;
    const n = ids.map((id) => list.find((x) => x.id === id)?.name ?? '?');
    parts.push(n.length <= 2 ? n.join(', ') : `${n.length} ${what}`);
  };
  names(c.itemIds, lookups.items, 'items');
  if (c.itemTypes?.length) parts.push(c.itemTypes.map((t) => PRICEABLE_TYPES.find((p) => p.value === t)?.label ?? t).join('/'));
  if (c.itemCustomField?.name) parts.push(`${c.itemCustomField.name} = ${c.itemCustomField.value}`);
  names(c.customerIds, lookups.customers, 'customers');
  names(c.customerTypeIds, lookups.customerTypes, 'customer types');
  names(c.jobIds, lookups.jobs, 'jobs');
  names(c.classIds, lookups.classes, 'classes');
  names(c.salesRepIds, lookups.salesReps, 'reps');
  return parts.length ? parts.join(' · ') : 'Everything';
}

function RulesTab({ rules, lookups, reload }: { rules: PriceRule[]; lookups: Lookups; reload: () => void }) {
  const [editing, setEditing] = useState<PriceRule | null>(null);
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<PriceRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    if (!del) return;
    setDeleting(true);
    try {
      await api.del(`/api/pricing/rules/${del.id}`);
      toast('Price rule deleted.', 'success');
      setDel(null);
      reload();
    } catch (err) {
      toast(errMsg(err, 'Failed to delete.'), 'danger');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <p className="text-sm text-navy/60">Rules adjust prices automatically on estimates, sales orders, invoices and sales receipts.</p>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="h-4 w-4" /> New rule
        </Button>
      </div>
      {rules.length === 0 ? (
        <EmptyState icon={BadgePercent} title="No price rules yet" message="Create a rule like “Wholesale customers get 10% off” or “Buy 10+, save 15%”." />
      ) : (
        <Table>
          <thead>
            <Tr>
              <Th numeric>Priority</Th>
              <Th>Rule</Th>
              <Th>Applies to</Th>
              <Th>Adjustment</Th>
              <Th>Dates</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </Tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <Tr key={r.id}>
                <Td numeric>{r.priority}</Td>
                <Td>
                  <div className="font-semibold text-navy">{r.name}</div>
                  {r.description && <div className="text-xs text-navy/50">{r.description}</div>}
                </Td>
                <Td className="text-sm text-navy/70">
                  {summarizeConditions(r.conditions, lookups)}
                  {r.minQuantity && <span className="text-navy/50"> · qty ≥ {Number(r.minQuantity)}</span>}
                </Td>
                <Td className="text-sm">
                  {describeAdjustment(r.adjustment)}
                  {r.tiers && r.tiers.length > 0 && <div className="text-xs text-navy/50">{r.tiers.length} quantity tier{r.tiers.length > 1 ? 's' : ''}</div>}
                </Td>
                <Td className="text-xs text-navy/60">{r.startDate || r.endDate ? `${r.startDate ?? '…'} → ${r.endDate ?? '…'}` : 'Always'}</Td>
                <Td>{r.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                <Td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setOpen(true); }} aria-label={`Edit ${r.name}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDel(r)} aria-label={`Delete ${r.name}`}>
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <RuleModal open={open} rule={editing} onClose={() => setOpen(false)} onSaved={reload} lookups={lookups} />
      <ConfirmDialog
        open={!!del}
        title="Delete price rule?"
        message={`“${del?.name}” will stop applying to new documents. Documents already saved keep their prices.`}
        confirmLabel="Delete"
        tone="danger"
        loading={deleting}
        onConfirm={remove}
        onClose={() => setDel(null)}
      />
    </Card>
  );
}

function LevelModal({
  open,
  level,
  items,
  onClose,
  onSaved,
}: {
  open: boolean;
  level: PriceLevel | null;
  items: Item[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'fixed_percent' | 'per_item'>('fixed_percent');
  const [direction, setDirection] = useState<'decrease' | 'increase'>('decrease');
  const [pct, setPct] = useState('');
  const [rounding, setRounding] = useState<RoundingMode>('none');
  const [active, setActive] = useState(true);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [bulkPct, setBulkPct] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const p = Number(level?.percent ?? 0);
    setName(level?.name ?? '');
    setType(level?.type ?? 'fixed_percent');
    setDirection(p > 0 ? 'increase' : 'decrease');
    setPct(p ? String(Math.abs(p)) : '');
    setRounding(level?.rounding ?? 'none');
    setActive(level?.isActive ?? true);
    setPrices(Object.fromEntries((level?.items ?? []).map((i) => [i.itemId, String(Number(i.price))])));
    setBulkPct('');
  }, [open, level]);

  const sellable = items.filter((i) => i.isActive && ['service', 'inventory', 'non_inventory', 'bundle', 'other_charge'].includes(i.type));

  function applyBulk() {
    const n = Number(bulkPct);
    if (!Number.isFinite(n)) return;
    const next: Record<string, string> = {};
    for (const it of sellable) {
      if (it.salesPrice == null) continue;
      next[it.id] = (Math.round(Number(it.salesPrice) * (100 + n)) / 100).toFixed(2);
    }
    setPrices(next);
  }

  async function save() {
    if (!name.trim()) return toast('Name the price level.', 'danger');
    const signed = type === 'fixed_percent' ? (direction === 'decrease' ? -1 : 1) * (Number(pct) || 0) : 0;
    setSaving(true);
    try {
      const body = { name: name.trim(), type, percent: String(signed), rounding, isActive: active };
      const saved = level
        ? await api.put<PriceLevel>(`/api/pricing/levels/${level.id}`, body)
        : await api.post<PriceLevel>('/api/pricing/levels', body);
      if (type === 'per_item') {
        const entries = Object.entries(prices)
          .filter(([, v]) => v !== '' && Number.isFinite(Number(v)))
          .map(([itemId, price]) => ({ itemId, price }));
        await api.put(`/api/pricing/levels/${saved.id}/items`, { items: entries });
      }
      toast('Price level saved.', 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(errMsg(err, 'Failed to save the price level.'), 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={level ? `Edit price level — ${level.name}` : 'New price level'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="lvl-name">Name *</Label>
            <Input id="lvl-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <Label htmlFor="lvl-type">Type</Label>
            <Select id="lvl-type" value={type} onChange={(e) => setType(e.target.value as typeof type)} disabled={!!level}>
              <option value="fixed_percent">Fixed % — every item up or down by a percent</option>
              <option value="per_item">Per item — a custom price for each item</option>
            </Select>
          </div>
        </div>
        {type === 'fixed_percent' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="lvl-dir">This level will</Label>
              <Select id="lvl-dir" value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
                <option value="decrease">decrease prices by</option>
                <option value="increase">increase prices by</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="lvl-pct">Percent</Label>
              <Input id="lvl-pct" type="number" min="0" step="any" value={pct} onChange={(e) => setPct(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="lvl-round">Rounding</Label>
              <Select id="lvl-round" value={rounding} onChange={(e) => setRounding(e.target.value as RoundingMode)}>
                {ROUNDING_MODES.map((m) => (
                  <option key={m} value={m}>{ROUNDING_LABELS[m]}</option>
                ))}
              </Select>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-end gap-2 mb-2">
              <div>
                <Label htmlFor="lvl-bulk">Fill from base price ± %</Label>
                <Input id="lvl-bulk" type="number" step="any" placeholder="-10" value={bulkPct} onChange={(e) => setBulkPct(e.target.value)} className="w-28" />
              </div>
              <Button variant="secondary" size="sm" onClick={applyBulk}>Fill prices</Button>
              <p className="text-xs text-navy/50 pb-1">Items left blank use their normal price.</p>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
              <Table>
                <thead>
                  <Tr>
                    <Th>Item</Th>
                    <Th numeric>Base price</Th>
                    <Th numeric>Level price</Th>
                  </Tr>
                </thead>
                <tbody>
                  {sellable.map((it) => (
                    <Tr key={it.id}>
                      <Td>{it.name}</Td>
                      <Td numeric className="text-navy/60">{it.salesPrice != null ? formatCurrency(it.salesPrice) : '—'}</Td>
                      <Td numeric>
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          className="w-28 ml-auto text-right"
                          value={prices[it.id] ?? ''}
                          onChange={(e) => setPrices((p) => ({ ...p, [it.id]: e.target.value }))}
                          aria-label={`Level price for ${it.name}`}
                        />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-navy">
          <input type="checkbox" className="accent-electric" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
      </div>
    </Modal>
  );
}

function LevelsTab({ levels, items, reload }: { levels: PriceLevel[]; items: Item[]; reload: () => void }) {
  const [editing, setEditing] = useState<PriceLevel | null>(null);
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<PriceLevel | null>(null);

  async function remove() {
    if (!del) return;
    try {
      await api.del(`/api/pricing/levels/${del.id}`);
      toast('Price level deleted.', 'success');
      setDel(null);
      reload();
    } catch (err) {
      toast(errMsg(err, 'Failed to delete.'), 'danger');
    }
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <p className="text-sm text-navy/60">Assign a price level to a customer on the Customers tab.</p>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="h-4 w-4" /> New price level
        </Button>
      </div>
      {levels.length === 0 ? (
        <EmptyState icon={Layers} title="No price levels" message="Price levels give a customer a standing discount or markup, or a custom price list." />
      ) : (
        <Table>
          <thead>
            <Tr>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Adjustment</Th>
              <Th>Rounding</Th>
              <Th numeric>Customers</Th>
              <Th className="text-right">Actions</Th>
            </Tr>
          </thead>
          <tbody>
            {levels.map((l) => (
              <Tr key={l.id}>
                <Td className="font-semibold">
                  {l.name} {!l.isActive && <Badge>Inactive</Badge>}
                </Td>
                <Td>{l.type === 'per_item' ? 'Per item' : 'Fixed %'}</Td>
                <Td>
                  {l.type === 'per_item'
                    ? `${l.items.length} item price${l.items.length === 1 ? '' : 's'}`
                    : `${Number(l.percent) > 0 ? '+' : ''}${Number(l.percent)}%`}
                </Td>
                <Td className="text-sm text-navy/60">{ROUNDING_LABELS[l.rounding] ?? l.rounding}</Td>
                <Td numeric>{l.customerCount}</Td>
                <Td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(l); setOpen(true); }} aria-label={`Edit ${l.name}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDel(l)} aria-label={`Delete ${l.name}`}>
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <LevelModal open={open} level={editing} items={items} onClose={() => setOpen(false)} onSaved={reload} />
      <ConfirmDialog
        open={!!del}
        title="Delete price level?"
        message={`“${del?.name}” will be removed from ${del?.customerCount ?? 0} customer(s). Saved documents keep their prices.`}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={remove}
        onClose={() => setDel(null)}
      />
    </Card>
  );
}

function CustomersTab({
  customers,
  levels,
  customerTypes,
  reload,
}: {
  customers: Customer[];
  levels: PriceLevel[];
  customerTypes: TypeRow[];
  reload: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const shown = customers.filter((c) => c.displayName.toLowerCase().includes(filter.toLowerCase()));

  async function assign(c: Customer, patch: { customerTypeId?: string | null; priceLevelId?: string | null }) {
    setBusy(c.id);
    try {
      await api.patch(`/api/pricing/customers/${c.id}`, patch);
      reload();
    } catch (err) {
      toast(errMsg(err, 'Failed to update the customer.'), 'danger');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
        <Input placeholder="Find a customer…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
        <p className="text-sm text-navy/50">Sub-customers and jobs without their own settings use their parent’s.</p>
      </div>
      <Table>
        <thead>
          <Tr>
            <Th>Customer</Th>
            <Th>Customer type</Th>
            <Th>Price level</Th>
          </Tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <Tr key={c.id}>
              <Td className="font-medium">
                {c.displayName} {busy === c.id && <Spinner className="inline h-3.5 w-3.5 text-electric" />}
              </Td>
              <Td>
                <Select value={c.customerTypeId ?? ''} onChange={(e) => assign(c, { customerTypeId: e.target.value || null })} aria-label={`Type for ${c.displayName}`}>
                  <option value="">—</option>
                  {customerTypes.filter((t) => t.isActive || t.id === c.customerTypeId).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </Select>
              </Td>
              <Td>
                <Select value={c.priceLevelId ?? ''} onChange={(e) => assign(c, { priceLevelId: e.target.value || null })} aria-label={`Price level for ${c.displayName}`}>
                  <option value="">Standard prices</option>
                  {levels.filter((l) => l.isActive || l.id === c.priceLevelId).map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function TypeListCard({ kind, types, reload }: { kind: 'customer' | 'vendor'; types: TypeRow[]; reload: () => void }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<TypeRow | null>(null);
  const [editName, setEditName] = useState('');

  async function add() {
    if (!name.trim()) return;
    try {
      await api.post(`/api/type-lists/${kind}`, { name: name.trim() });
      setName('');
      reload();
    } catch (err) {
      toast(errMsg(err, 'Failed to add.'), 'danger');
    }
  }
  async function rename() {
    if (!editing || !editName.trim()) return;
    try {
      await api.put(`/api/type-lists/${kind}/${editing.id}`, { name: editName.trim(), parentId: editing.parentId, isActive: editing.isActive });
      setEditing(null);
      reload();
    } catch (err) {
      toast(errMsg(err, 'Failed to rename.'), 'danger');
    }
  }
  async function remove(t: TypeRow) {
    try {
      const res = await api.del<{ deleted: boolean; deactivated: boolean }>(`/api/type-lists/${kind}/${t.id}`);
      toast(res.deactivated ? `“${t.name}” is in use, so it was made inactive.` : `“${t.name}” deleted.`, 'success');
      reload();
    } catch (err) {
      toast(errMsg(err, 'Failed to delete.'), 'danger');
    }
  }

  return (
    <Card className="p-5">
      <h3 className="text-base font-bold text-navy mb-3">{kind === 'customer' ? 'Customer types' : 'Vendor types'}</h3>
      <div className="flex gap-2 mb-3">
        <Input placeholder={`New ${kind} type`} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button onClick={add} disabled={!name.trim()}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      {types.length === 0 ? (
        <p className="text-sm text-navy/50">No types yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {types.map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-2">
              {editing?.id === t.id ? (
                <>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename()} autoFocus />
                  <Button size="sm" onClick={rename}>Save</Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm text-navy">
                    {t.name} {!t.isActive && <Badge>Inactive</Badge>}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(t); setEditName(t.name); }} aria-label={`Rename ${t.name}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(t)} aria-label={`Delete ${t.name}`}>
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TypesTab({
  customerTypes,
  vendorTypes,
  vendors,
  reload,
}: {
  customerTypes: TypeRow[];
  vendorTypes: TypeRow[];
  vendors: Vendor[];
  reload: () => void;
}) {
  async function assignVendor(v: Vendor, vendorTypeId: string | null) {
    try {
      await api.post('/api/type-lists/vendor-assign', { vendorId: v.id, vendorTypeId });
      reload();
    } catch (err) {
      toast(errMsg(err, 'Failed to update the vendor.'), 'danger');
    }
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <TypeListCard kind="customer" types={customerTypes} reload={reload} />
      <TypeListCard kind="vendor" types={vendorTypes} reload={reload} />
      <Card className="p-5">
        <h3 className="text-base font-bold text-navy mb-3">Vendor type assignments</h3>
        {vendors.length === 0 ? (
          <p className="text-sm text-navy/50">No vendors yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto space-y-2">
            {vendors.map((v) => (
              <div key={v.id} className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm text-navy">{v.displayName}</span>
                <Select className="w-40" value={v.vendorTypeId ?? ''} onChange={(e) => assignVendor(v, e.target.value || null)} aria-label={`Type for ${v.displayName}`}>
                  <option value="">—</option>
                  {vendorTypes.filter((t) => t.isActive || t.id === v.vendorTypeId).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function PreferencesTab({ settings, reload }: { settings: PricingSettings; reload: () => void }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  async function save() {
    setSaving(true);
    try {
      await api.patch('/api/pricing/settings', draft);
      toast('Pricing preferences saved.', 'success');
      reload();
    } catch (err) {
      toast(errMsg(err, 'Failed to save preferences.'), 'danger');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card className="p-6 max-w-2xl space-y-5">
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 accent-electric" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        <span>
          <span className="font-semibold text-navy">Use price levels and price rules</span>
          <span className="block text-sm text-navy/60">When off, sales forms use each item’s normal price (customer-specific prices still apply).</span>
        </span>
      </label>
      <div>
        <Label>When more than one price applies</Label>
        <div className="space-y-2">
          <label className="flex items-start gap-3">
            <input type="radio" name="conflict" className="mt-1 accent-electric" checked={draft.conflictMode === 'lowest'} onChange={() => setDraft({ ...draft, conflictMode: 'lowest' })} />
            <span>
              <span className="font-medium text-navy">Lowest price wins</span>
              <span className="block text-sm text-navy/60">The customer always gets the best price from any matching rule, their price level, or their customer price.</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input type="radio" name="conflict" className="mt-1 accent-electric" checked={draft.conflictMode === 'priority'} onChange={() => setDraft({ ...draft, conflictMode: 'priority' })} />
            <span>
              <span className="font-medium text-navy">Priority wins</span>
              <span className="block text-sm text-navy/60">The matching rule with the lowest priority number wins, even if it is not the cheapest. Without a rule, the customer price, then the price level apply.</span>
            </span>
          </label>
        </div>
      </div>
      <div className="max-w-xs">
        <Label htmlFor="pref-round">Default rounding</Label>
        <Select id="pref-round" value={draft.defaultRounding} onChange={(e) => setDraft({ ...draft, defaultRounding: e.target.value as RoundingMode })}>
          {ROUNDING_MODES.map((m) => (
            <option key={m} value={m}>{ROUNDING_LABELS[m]}</option>
          ))}
        </Select>
      </div>
      <Button onClick={save} loading={saving}>Save preferences</Button>
    </Card>
  );
}

function PriceCheck({ items, customers, lookups }: { items: Item[]; customers: Customer[]; lookups: Lookups }) {
  const [customerId, setCustomerId] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('1');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [classId, setClassId] = useState('');
  const [repId, setRepId] = useState('');
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [loading, setLoading] = useState(false);

  async function check() {
    if (!itemId) return toast('Pick an item.', 'danger');
    setLoading(true);
    try {
      const res = await api.post<{ quotes: PriceQuote[] }>('/api/pricing/quote', {
        customerId: customerId || null,
        date,
        classId: classId || null,
        salesRepId: repId || null,
        lines: [{ itemId, quantity: qty || '1' }],
      });
      setQuote(res.quotes[0] ?? null);
    } catch (err) {
      toast(errMsg(err, 'Price check failed.'), 'danger');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="p-5 mb-6">
      <h3 className="text-base font-bold text-navy mb-3 flex items-center gap-2">
        <Search className="h-4 w-4 text-electric" /> Price check
      </h3>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-7 items-end">
        <div className="md:col-span-2">
          <Label htmlFor="pc-cust">Customer</Label>
          <Select id="pc-cust" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">(no customer)</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </Select>
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="pc-item">Item</Label>
          <Select id="pc-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Choose…</option>
            {items.filter((i) => i.isActive).map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="pc-qty">Qty</Label>
          <Input id="pc-qty" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pc-date">Date</Label>
          <Input id="pc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Button onClick={check} loading={loading}>Check</Button>
        <div className="md:col-span-2">
          <Label htmlFor="pc-class">Class</Label>
          <Select id="pc-class" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">—</option>
            {lookups.classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="pc-rep">Sales rep</Label>
          <Select id="pc-rep" value={repId} onChange={(e) => setRepId(e.target.value)}>
            <option value="">—</option>
            {lookups.salesReps.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </div>
      </div>
      {quote && (
        <div className="mt-4 rounded-lg bg-navy/5 p-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-2xl font-bold text-navy tabular-nums">{formatCurrency(quote.price)}</span>
            <span className="text-sm text-navy/60">base {formatCurrency(quote.basePrice)}</span>
            <Badge tone={quote.source === 'base' ? 'neutral' : 'success'}>{quote.label}</Badge>
          </div>
          {quote.candidates.length > 0 && (
            <ul className="mt-2 text-sm text-navy/70">
              {quote.candidates.map((c) => (
                <li key={`${c.source}-${c.id}`}>
                  {c.source === 'price_rule' ? 'Rule' : c.source === 'price_level' ? 'Price level' : 'Customer price'}: {c.name}
                  {c.priority != null ? ` (priority ${c.priority})` : ''}
                  {c.tierMinQuantity ? ` · tier ${c.tierMinQuantity}+` : ''} — {formatCurrency(c.price)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdvancedPricingPage() {
  const [tab, setTab] = useState<Tab>('rules');
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [jobs, setJobs] = useState<Named[]>([]);
  const [classes, setClasses] = useState<Named[]>([]);
  const [reps, setReps] = useState<Named[]>([]);
  const [customerTypes, setCustomerTypes] = useState<TypeRow[]>([]);
  const [vendorTypes, setVendorTypes] = useState<TypeRow[]>([]);
  const [levels, setLevels] = useState<PriceLevel[]>([]);
  const [rules, setRules] = useState<PriceRule[]>([]);
  const [settings, setSettings] = useState<PricingSettings>({ enabled: true, conflictMode: 'lowest', defaultRounding: 'none' });

  const load = useCallback(async () => {
    try {
      const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
      const [it, cu, ve, jo, cl, sr, ct, vt, lv, ru, st] = await Promise.all([
        api.get<{ items: Item[] }>('/api/items'),
        api.get<Customer[]>('/api/customers'),
        soft(api.get<Vendor[]>('/api/vendors'), []),
        soft(api.get<Named[]>('/api/jobs'), []),
        soft(api.get<Named[]>('/api/classes'), []),
        soft(api.get<Named[]>('/api/sales-reps'), []),
        api.get<{ types: TypeRow[] }>('/api/type-lists/customer'),
        api.get<{ types: TypeRow[] }>('/api/type-lists/vendor'),
        api.get<{ levels: PriceLevel[] }>('/api/pricing/levels'),
        api.get<{ rules: PriceRule[] }>('/api/pricing/rules'),
        api.get<PricingSettings>('/api/pricing/settings'),
      ]);
      setItems(it.items ?? []);
      setCustomers(cu);
      setVendors(Array.isArray(ve) ? ve : []);
      setJobs(Array.isArray(jo) ? jo : []);
      setClasses(Array.isArray(cl) ? cl : []);
      setReps(Array.isArray(sr) ? sr : []);
      setCustomerTypes(ct.types);
      setVendorTypes(vt.types);
      setLevels(lv.levels);
      setRules(ru.rules);
      setSettings(st);
    } catch (err) {
      toast(errMsg(err, 'Failed to load pricing data.'), 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const lookups: Lookups = useMemo(
    () => ({
      items: items.filter((i) => i.isActive).map((i) => ({ id: i.id, name: i.name })),
      customers: customers.map((c) => ({ id: c.id, name: c.displayName })),
      customerTypes: customerTypes.filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name })),
      jobs: jobs.map((j) => ({ id: j.id, name: j.name })),
      classes: classes.map((c) => ({ id: c.id, name: c.name })),
      salesReps: reps.map((r) => ({ id: r.id, name: r.name })),
    }),
    [items, customers, customerTypes, jobs, classes, reps],
  );

  const tabs: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'rules', label: `Price rules (${rules.length})`, icon: BadgePercent },
    { id: 'levels', label: `Price levels (${levels.length})`, icon: Layers },
    { id: 'customers', label: 'Customers', icon: Users },
    { id: 'types', label: 'Customer & vendor types', icon: ListTree },
    { id: 'preferences', label: 'Preferences', icon: Settings2 },
  ];

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Advanced Pricing" icon={BadgePercent} />
      {!settings.enabled && !loading && (
        <div className="mb-4 rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm text-yellow-800">
          Price levels and rules are turned off in Preferences — sales forms use normal item prices.
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-20 text-navy/40">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <>
          <PriceCheck items={items} customers={customers} lookups={lookups} />
          <div className="mb-4 flex flex-wrap gap-2" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  tab === t.id ? 'bg-electric text-white' : 'bg-white text-navy hover:bg-slate-50 border border-slate-200'
                }`}
              >
                <t.icon className="h-4 w-4" /> {t.label}
              </button>
            ))}
          </div>
          {tab === 'rules' && <RulesTab rules={rules} lookups={lookups} reload={load} />}
          {tab === 'levels' && <LevelsTab levels={levels} items={items} reload={load} />}
          {tab === 'customers' && <CustomersTab customers={customers} levels={levels} customerTypes={customerTypes} reload={load} />}
          {tab === 'types' && <TypesTab customerTypes={customerTypes} vendorTypes={vendorTypes} vendors={vendors} reload={load} />}
          {tab === 'preferences' && <PreferencesTab settings={settings} reload={load} />}
        </>
      )}
    </main>
  );
}
