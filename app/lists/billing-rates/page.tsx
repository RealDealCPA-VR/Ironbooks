'use client';
/**
 * Billing Rate Levels — /lists/billing-rates
 * Hourly rates used when billable time is put on invoices: one flat rate for everything, or a
 * custom rate per service item. Assign a level to the employees, vendors or other names whose
 * time you bill.
 */
import { useCallback, useEffect, useState } from 'react';
import { Timer, Plus, Pencil, Trash2 } from 'lucide-react';
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
import { formatCurrency } from '@/lib/money';

interface Level {
  id: string;
  name: string;
  type: 'fixed_rate' | 'custom';
  fixedRate: string | null;
  isActive: boolean;
}
interface LevelDetail extends Level {
  items: Array<{ itemId: string; rate: string; itemName: string }>;
}
interface Option {
  id: string;
  label: string;
  billingRateLevelId?: string | null;
}

export default function BillingRatesPage() {
  const [levels, setLevels] = useState<Level[]>([]);
  const [services, setServices] = useState<Array<{ id: string; name: string; salesPrice: string | null }>>([]);
  const [people, setPeople] = useState<{ employees: Option[]; vendors: Option[] }>({ employees: [], vendors: [] });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LevelDetail | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<'fixed_rate' | 'custom'>('fixed_rate');
  const [fixedRate, setFixedRate] = useState('');
  const [rates, setRates] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Level | null>(null);
  const [assignKind, setAssignKind] = useState<'employee' | 'vendor'>('employee');
  const [assignId, setAssignId] = useState('');
  const [assignLevel, setAssignLevel] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ levels: Level[] }>('/api/billing-rate-levels?includeInactive=true');
      setLevels(d.levels);
    } catch (err) {
      toastError(err, 'Could not load billing rate levels.');
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .get<{ items: Array<{ id: string; name: string; type: string; salesPrice: string | null }> }>('/api/items?type=service')
      .then((d) => setServices(d.items))
      .catch(() => {});
    Promise.all([
      api.get<Array<{ id: string; firstName: string; lastName: string; billingRateLevelId?: string | null }>>('/api/employees').catch(() => []),
      api.get<Array<{ id: string; displayName: string; billingRateLevelId?: string | null }>>('/api/vendors').catch(() => []),
    ]).then(([e, v]) =>
      setPeople({
        employees: e.map((x) => ({ id: x.id, label: `${x.firstName} ${x.lastName}`, billingRateLevelId: x.billingRateLevelId })),
        vendors: v.map((x) => ({ id: x.id, label: x.displayName, billingRateLevelId: x.billingRateLevelId })),
      }),
    );
  }, [load]);

  function openNew() {
    setEditing(null);
    setName('');
    setType('fixed_rate');
    setFixedRate('');
    setRates({});
    setOpen(true);
  }

  async function openEdit(l: Level) {
    try {
      const d = await api.get<LevelDetail>(`/api/billing-rate-levels/${l.id}`);
      setEditing(d);
      setName(d.name);
      setType(d.type);
      setFixedRate(d.fixedRate ?? '');
      setRates(Object.fromEntries(d.items.map((i) => [i.itemId, i.rate])));
      setOpen(true);
    } catch (err) {
      toastError(err, 'Could not open the level.');
    }
  }

  async function save() {
    setSaving(true);
    const body = {
      name,
      type,
      fixedRate: type === 'fixed_rate' ? fixedRate || null : null,
      items: type === 'custom' ? Object.entries(rates).filter(([, r]) => r !== '').map(([itemId, rate]) => ({ itemId, rate })) : [],
      isActive: editing?.isActive ?? true,
    };
    try {
      if (editing) await api.put(`/api/billing-rate-levels/${editing.id}`, body);
      else await api.post('/api/billing-rate-levels', body);
      toast('Saved.', 'success');
      setOpen(false);
      await load();
    } catch (err) {
      toastError(err, 'Could not save the level.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    try {
      const r = await api.del<{ deleted: boolean }>(`/api/billing-rate-levels/${deleteTarget.id}`);
      toast(r.deleted ? 'Deleted.' : 'This level is assigned to someone, so it was made inactive instead.', 'info');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not delete the level.');
    }
  }

  async function assign() {
    if (!assignId) return;
    try {
      await api.post('/api/billing-rate-levels/assign', {
        [assignKind === 'employee' ? 'employeeId' : 'vendorId']: assignId,
        levelId: assignLevel || null,
      });
      toast('Billing rate level assigned.', 'success');
    } catch (err) {
      toastError(err, 'Could not assign the level.');
    }
  }

  const list = assignKind === 'employee' ? people.employees : people.vendors;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Billing Rate Levels"
        icon={Timer}
        action={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" /> New level
          </Button>
        }
      />
      <Card className="mb-6 p-6">
        <p className="mb-4 text-sm text-navy/60">
          When you bill a customer for someone&apos;s time, their billing rate level sets the hourly rate. Without a level, the
          service item&apos;s own price is used.
        </p>
        {levels.length === 0 ? (
          <EmptyState icon={Timer} title="No billing rate levels yet" message="Create one, then assign it to the people whose time you bill." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th numeric>Hourly rate</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => (
                <Tr key={l.id}>
                  <Td>{l.name}</Td>
                  <Td>{l.type === 'fixed_rate' ? 'One rate for all services' : 'A rate per service item'}</Td>
                  <Td numeric>{l.type === 'fixed_rate' && l.fixedRate ? formatCurrency(l.fixedRate) : '—'}</Td>
                  <Td>{l.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(l)} aria-label={`Edit ${l.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(l)} aria-label={`Delete ${l.name}`}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-3 text-lg font-bold text-navy">Assign a level</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="as-kind">Who</Label>
            <Select id="as-kind" value={assignKind} onChange={(e) => { setAssignKind(e.target.value as 'employee' | 'vendor'); setAssignId(''); }}>
              <option value="employee">Employee</option>
              <option value="vendor">Vendor (subcontractor)</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="as-person">Name</Label>
            <Select id="as-person" value={assignId} onChange={(e) => { setAssignId(e.target.value); setAssignLevel(list.find((p) => p.id === e.target.value)?.billingRateLevelId ?? ''); }}>
              <option value="">Choose…</option>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="as-level">Billing rate level</Label>
            <Select id="as-level" value={assignLevel} onChange={(e) => setAssignLevel(e.target.value)}>
              <option value="">None (use item prices)</option>
              {levels.filter((l) => l.isActive).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={assign} disabled={!assignId}>
            Assign
          </Button>
        </div>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit billing rate level' : 'New billing rate level'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={!name.trim()}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="brl-name" required>
              Name
            </Label>
            <Input id="brl-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="brl-type">Kind</Label>
            <Select id="brl-type" value={type} onChange={(e) => setType(e.target.value as 'fixed_rate' | 'custom')}>
              <option value="fixed_rate">One hourly rate for every service</option>
              <option value="custom">A different rate for each service item</option>
            </Select>
          </div>
          {type === 'fixed_rate' ? (
            <div>
              <Label htmlFor="brl-rate" required>
                Hourly rate
              </Label>
              <Input id="brl-rate" type="number" step="0.01" min="0" value={fixedRate} onChange={(e) => setFixedRate(e.target.value)} />
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Service item</Th>
                  <Th numeric>Item price</Th>
                  <Th numeric>Rate for this level</Th>
                </tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <Tr key={s.id}>
                    <Td>{s.name}</Td>
                    <Td numeric>{s.salesPrice ? formatCurrency(s.salesPrice) : '—'}</Td>
                    <Td numeric>
                      <Input
                        aria-label={`Rate for ${s.name}`}
                        type="number"
                        step="0.01"
                        min="0"
                        className="w-28 text-right"
                        value={rates[s.id] ?? ''}
                        placeholder="item price"
                        onChange={(e) => setRates((prev) => ({ ...prev, [s.id]: e.target.value }))}
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete billing rate level?"
        message="If anyone is assigned this level it will be made inactive instead."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={remove}
        onClose={() => setDeleteTarget(null)}
      />
    </main>
  );
}
