'use client';
/**
 * Sales Tax Items (QB Item List, type "Sales Tax Item"): add an item, rename it, change its rate,
 * set the tax agency it is paid to (or add a new agency on the spot), make it inactive / active
 * again, and show inactive items. The server checks everything again: the name is unique in the
 * company, the agency is one of the company's, an item made of components keeps the total of its
 * components, and inactive items are left out of the tax pick-lists on new sales forms.
 *
 * A new rate applies to sales entered from then on: saved invoices, sales receipts and credit
 * memos keep the tax amount they were saved with.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { Money } from '@/lib/money';

export interface SalesTaxItem {
  id: string;
  name: string;
  rate: string;
  agencyId: string | null;
  isActive: boolean;
}

interface Agency {
  id: string;
  name: string;
}

const NEW_AGENCY = '__new__';

/** "0.082500" -> "8.25" (exact decimals, no float rounding). */
export function fractionToPercent(rate: string): string {
  try {
    return Money.of(rate).times(100).toFixed(4).replace(/\.?0+$/, '');
  } catch {
    return '';
  }
}

/** "8.25" -> "0.082500"; null when the text is not a percentage from 0 to 100. */
export function percentToFraction(pct: string): string | null {
  const t = pct.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(t)) return null;
  const v = Money.of(t);
  if (v.greaterThan(100)) return null;
  return v.dividedBy(100).toFixed(6);
}

interface FormState {
  name: string;
  percent: string;
  agencyId: string;
  newAgencyName: string;
  isActive: boolean;
}

const EMPTY: FormState = { name: '', percent: '', agencyId: '', newAgencyName: '', isActive: true };

export function SalesTaxItemsPanel({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<SalesTaxItem[]>([]);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SalesTaxItem | null>(null);
  /** The item being edited is made of component rates: its rate is their total. */
  const [hasComponents, setHasComponents] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [items, ags] = await Promise.all([
        api.get<SalesTaxItem[]>('/api/tax-rates?includeInactive=true'),
        api.get<Agency[]>('/api/tax-agencies').catch(() => [] as Agency[]),
      ]);
      setRows([...items].sort((a, b) => a.name.localeCompare(b.name)));
      setAgencies([...ags].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      toastError(err, 'Could not load the sales tax items.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agencyName = (id: string | null) => (id ? (agencies.find((a) => a.id === id)?.name ?? '—') : '—');
  const shown = rows.filter((r) => showInactive || r.isActive);

  function openNew() {
    setEditing(null);
    setHasComponents(false);
    setForm(EMPTY);
    setOpen(true);
  }

  function openEdit(r: SalesTaxItem) {
    setEditing(r);
    setHasComponents(false);
    setForm({ name: r.name, percent: fractionToPercent(r.rate), agencyId: r.agencyId ?? '', newAgencyName: '', isActive: r.isActive });
    setOpen(true);
    api
      .get<unknown[]>(`/api/tax-rates/${r.id}/components`)
      .then((c) => setHasComponents(Array.isArray(c) && c.length > 0))
      .catch(() => setHasComponents(false));
  }

  async function save() {
    const name = form.name.trim();
    if (!name) {
      toast('Give the sales tax item a name.', 'danger');
      return;
    }
    const rate = percentToFraction(form.percent);
    if (rate === null) {
      toast('Enter the rate as a percentage from 0 to 100, for example 8.25.', 'danger');
      return;
    }
    if (form.agencyId === NEW_AGENCY && !form.newAgencyName.trim()) {
      toast('Type the name of the new tax agency.', 'danger');
      return;
    }
    setSaving(true);
    try {
      let agencyId: string | null = form.agencyId || null;
      if (form.agencyId === NEW_AGENCY) {
        const created = await api.post<Agency>('/api/tax-agencies', { name: form.newAgencyName.trim() });
        agencyId = created.id;
      }
      const body = {
        name,
        // An item made of components keeps the total of its components (the server refuses a
        // different rate), so its rate is not sent.
        ...(editing && hasComponents ? {} : { rate }),
        agencyId,
        isActive: form.isActive,
      };
      if (editing) await api.patch(`/api/tax-rates/${editing.id}`, body);
      else await api.post('/api/tax-rates', body);
      toast(editing ? 'Sales tax item saved.' : 'Sales tax item added.', 'success');
      setOpen(false);
      await load();
      onChanged?.();
    } catch (err) {
      toastError(err, 'Could not save the sales tax item.');
      // A new agency may have been added before the item failed: show it in the picker.
      if (form.agencyId === NEW_AGENCY) void load();
    } finally {
      setSaving(false);
    }
  }

  async function setActive(r: SalesTaxItem, isActive: boolean) {
    setTogglingId(r.id);
    try {
      await api.patch(`/api/tax-rates/${r.id}`, { isActive });
      toast(isActive ? `${r.name} is active again.` : `${r.name} is inactive. New sales forms no longer offer it.`, 'success');
      await load();
      onChanged?.();
    } catch (err) {
      toastError(err, 'Could not change the sales tax item.');
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <Card className="p-6 mb-8 max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-navy">Sales Tax Items</h2>
          <p className="text-sm text-navy/50">The tax you charge on sales, and the agency each one is paid to.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-navy/60 select-none">
            <input
              type="checkbox"
              className="h-4 w-4 accent-electric"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4" /> New sales tax item
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-6 text-electric">
          <Spinner className="h-5 w-5" />
        </div>
      ) : shown.length === 0 ? (
        <p className="py-4 text-sm text-navy/50">
          {rows.length === 0 ? 'No sales tax items yet. Add the rate you charge, for example "State Tax 6.25%".' : 'All sales tax items are inactive.'}
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th numeric>Rate</Th>
              <Th>Tax agency</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <Tr key={r.id}>
                <Td className={r.isActive ? 'font-semibold text-navy' : 'text-navy/50'}>{r.name}</Td>
                <Td numeric className="tabular-nums">{fractionToPercent(r.rate)}%</Td>
                <Td>{agencyName(r.agencyId)}</Td>
                <Td>{r.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(r)} aria-label={`Edit ${r.name}`}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" loading={togglingId === r.id} onClick={() => setActive(r, !r.isActive)}>
                      {r.isActive ? 'Make inactive' : 'Make active'}
                    </Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit sales tax item: ${editing.name}` : 'New sales tax item'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form="sales-tax-item-form" loading={saving}>
              {editing ? 'Save' : 'Add item'}
            </Button>
          </>
        }
      >
        <form
          id="sales-tax-item-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <Label htmlFor="sti-name">Name</Label>
            <Input
              id="sti-name"
              autoFocus
              maxLength={255}
              placeholder="e.g. State Tax"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="sti-rate">Rate (%)</Label>
            <Input
              id="sti-rate"
              inputMode="decimal"
              placeholder="e.g. 8.25"
              disabled={hasComponents}
              value={form.percent}
              onChange={(e) => setForm((f) => ({ ...f, percent: e.target.value }))}
            />
            <p className="mt-1 text-xs text-navy/50">
              {hasComponents
                ? 'This item is made of component rates; change the components below and the total updates itself.'
                : editing
                  ? 'A new rate applies to sales you enter from now on. Saved invoices and receipts keep the tax they were saved with.'
                  : 'Enter the percentage you charge.'}
            </p>
          </div>
          <div>
            <Label htmlFor="sti-agency">Tax agency (who you pay it to)</Label>
            <Select
              id="sti-agency"
              value={form.agencyId}
              onChange={(e) => setForm((f) => ({ ...f, agencyId: e.target.value }))}
            >
              <option value="">— None —</option>
              {agencies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              <option value={NEW_AGENCY}>+ Add a new tax agency…</option>
            </Select>
          </div>
          {form.agencyId === NEW_AGENCY && (
            <div>
              <Label htmlFor="sti-new-agency">New tax agency name</Label>
              <Input
                id="sti-new-agency"
                maxLength={255}
                placeholder="e.g. State Department of Revenue"
                value={form.newAgencyName}
                onChange={(e) => setForm((f) => ({ ...f, newAgencyName: e.target.value }))}
              />
            </div>
          )}
          {editing && (
            <label className="flex items-center gap-2 text-sm text-navy">
              <input
                type="checkbox"
                className="h-4 w-4 accent-electric"
                checked={!form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: !e.target.checked }))}
              />
              Item is inactive (new sales forms do not offer it)
            </label>
          )}
        </form>
      </Modal>
    </Card>
  );
}
