'use client';
/**
 * Units of Measure — /lists/uom
 * A unit-of-measure set has a base unit (stock is always counted in it) plus related units such
 * as "Case = 12 Each". Assign a set to an item on the Items page.
 */
import { useCallback, useEffect, useState } from 'react';
import { Ruler, Plus, Pencil, Trash2, MinusCircle } from 'lucide-react';
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
  Table,
  Td,
  Th,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';

interface Unit {
  name: string;
  abbrev: string;
  factor: string;
}
interface UomSet {
  id: string;
  name: string;
  kind: string;
  baseUnitName: string;
  baseUnitAbbrev: string;
  defaultPurchaseUnit: string | null;
  defaultSalesUnit: string | null;
  defaultShippingUnit: string | null;
  isActive: boolean;
  units: Unit[];
}

const EMPTY = {
  name: '',
  kind: 'count',
  baseUnitName: 'Each',
  baseUnitAbbrev: 'ea',
  defaultPurchaseUnit: '',
  defaultSalesUnit: '',
  defaultShippingUnit: '',
  units: [] as Unit[],
};

export default function UomPage() {
  const [sets, setSets] = useState<UomSet[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UomSet | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UomSet | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ sets: UomSet[] }>('/api/uom-sets?includeInactive=true');
      setSets(d.sets);
    } catch (err) {
      toastError(err, 'Could not load units of measure.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openNew() {
    setEditing(null);
    setForm({ ...EMPTY, units: [{ name: 'Case', abbrev: 'cs', factor: '12' }] });
    setOpen(true);
  }
  function openEdit(s: UomSet) {
    setEditing(s);
    setForm({
      name: s.name,
      kind: s.kind,
      baseUnitName: s.baseUnitName,
      baseUnitAbbrev: s.baseUnitAbbrev,
      defaultPurchaseUnit: s.defaultPurchaseUnit ?? '',
      defaultSalesUnit: s.defaultSalesUnit ?? '',
      defaultShippingUnit: s.defaultShippingUnit ?? '',
      units: s.units.map((u) => ({ name: u.name, abbrev: u.abbrev, factor: String(Number(u.factor)) })),
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    const body = {
      ...form,
      defaultPurchaseUnit: form.defaultPurchaseUnit || null,
      defaultSalesUnit: form.defaultSalesUnit || null,
      defaultShippingUnit: form.defaultShippingUnit || null,
      isActive: editing?.isActive ?? true,
    };
    try {
      if (editing) await api.put(`/api/uom-sets/${editing.id}`, body);
      else await api.post('/api/uom-sets', body);
      toast('Saved.', 'success');
      setOpen(false);
      await load();
    } catch (err) {
      toastError(err, 'Could not save the unit of measure set.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    try {
      const r = await api.del<{ deleted: boolean }>(`/api/uom-sets/${deleteTarget.id}`);
      toast(r.deleted ? 'Deleted.' : 'Items use this set, so it was made inactive instead.', 'info');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not delete the set.');
    }
  }

  const unitNames = [form.baseUnitName, ...form.units.map((u) => u.name)].filter(Boolean);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Units of Measure"
        icon={Ruler}
        action={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" /> New set
          </Button>
        }
      />
      <Card className="p-6">
        <p className="mb-4 text-sm text-navy/60">
          Buy by the case and sell by the each: stock is always counted in the base unit, and a quantity entered in another
          unit is converted (2 cases of 12 = 24 each).
        </p>
        {sets.length === 0 ? (
          <EmptyState icon={Ruler} title="No unit of measure sets yet" message="Create a set such as “Count — Each, Case of 12”." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Base unit</Th>
                <Th>Other units</Th>
                <Th>Defaults (buy / sell / ship)</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {sets.map((s) => (
                <Tr key={s.id}>
                  <Td>{s.name}</Td>
                  <Td>
                    {s.baseUnitName} ({s.baseUnitAbbrev})
                  </Td>
                  <Td>{s.units.map((u) => `${u.name} = ${Number(u.factor)} ${s.baseUnitAbbrev}`).join(', ') || '—'}</Td>
                  <Td>{[s.defaultPurchaseUnit, s.defaultSalesUnit, s.defaultShippingUnit].map((x) => x ?? '—').join(' / ')}</Td>
                  <Td>{s.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(s)} aria-label={`Edit ${s.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(s)} aria-label={`Delete ${s.name}`}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit unit of measure set' : 'New unit of measure set'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={!form.name.trim() || !form.baseUnitName.trim()}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="uom-name" required>
                Set name
              </Label>
              <Input id="uom-name" value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Count by the case" />
            </div>
            <div>
              <Label htmlFor="uom-kind">Measures</Label>
              <Select id="uom-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {['count', 'length', 'weight', 'volume', 'area', 'time', 'other'].map((k) => (
                  <option key={k} value={k}>
                    {k[0].toUpperCase() + k.slice(1)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="uom-base" required>
                Base unit (stock is counted in this)
              </Label>
              <Input id="uom-base" value={form.baseUnitName} maxLength={50} onChange={(e) => setForm({ ...form, baseUnitName: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="uom-base-abbr" required>
                Abbreviation
              </Label>
              <Input id="uom-base-abbr" value={form.baseUnitAbbrev} maxLength={20} onChange={(e) => setForm({ ...form, baseUnitAbbrev: e.target.value })} />
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-navy">Related units</p>
            {form.units.map((u, i) => (
              <div key={i} className="mb-2 grid grid-cols-[1fr_6rem_8rem_auto] items-center gap-2">
                <Input aria-label="Unit name" value={u.name} maxLength={50} placeholder="Case" onChange={(e) => setForm({ ...form, units: form.units.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
                <Input aria-label="Abbreviation" value={u.abbrev} maxLength={20} placeholder="cs" onChange={(e) => setForm({ ...form, units: form.units.map((x, k) => (k === i ? { ...x, abbrev: e.target.value } : x)) })} />
                <div className="flex items-center gap-1 text-sm text-navy/60">
                  =
                  <Input aria-label="How many base units" type="number" step="any" min="0" value={u.factor} onChange={(e) => setForm({ ...form, units: form.units.map((x, k) => (k === i ? { ...x, factor: e.target.value } : x)) })} />
                  {form.baseUnitAbbrev}
                </div>
                <button type="button" aria-label="Remove unit" onClick={() => setForm({ ...form, units: form.units.filter((_, k) => k !== i) })}>
                  <MinusCircle className="h-4 w-4 text-navy/30 hover:text-red-500" />
                </button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setForm({ ...form, units: [...form.units, { name: '', abbrev: '', factor: '' }] })}>
              <Plus className="h-4 w-4" /> Add unit
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {(['defaultPurchaseUnit', 'defaultSalesUnit', 'defaultShippingUnit'] as const).map((k) => (
              <div key={k}>
                <Label htmlFor={`uom-${k}`}>{k === 'defaultPurchaseUnit' ? 'Buy in' : k === 'defaultSalesUnit' ? 'Sell in' : 'Ship in'}</Label>
                <Select id={`uom-${k}`} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
                  <option value="">—</option>
                  {unitNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </div>
      </Modal>
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete unit of measure set?"
        message="If items use this set it will be made inactive instead."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={remove}
        onClose={() => setDeleteTarget(null)}
      />
    </main>
  );
}
