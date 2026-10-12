'use client';
/**
 * Generic add / edit / delete-or-make-inactive editor for the simple QB lists
 * (lib/services/lists/simpleLists.ts, /api/lists/:list) and the Customer / Vendor Type lists
 * (/api/type-lists/:kind). Field specs come from lib/lists/listSpecs.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
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
import type { FieldSpec, ListSpec } from '@/lib/lists/listSpecs';

type Entry = Record<string, unknown> & { id: string; isActive: boolean };

function emptyForm(spec: ListSpec): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  for (const field of spec.fields) f[field.key] = field.default ?? (field.type === 'bool' ? false : '');
  return f;
}

function toForm(spec: ListSpec, e: Entry): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const v = e[field.key];
    f[field.key] = field.type === 'bool' ? !!v : v == null ? '' : String(v);
  }
  return f;
}

/** Form → request body: '' → null, numbers stay strings (the API accepts decimal strings). */
function toBody(spec: ListSpec, form: Record<string, unknown>, editing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of spec.fields) {
    if (field.showIf && !field.showIf(form)) {
      if (editing) body[field.key] = null;
      continue;
    }
    const v = form[field.key];
    if (field.type === 'bool') body[field.key] = !!v;
    else if (v === '' || v == null) {
      if (editing || field.sendEmptyAsNull) body[field.key] = null;
    } else if (field.type === 'int') body[field.key] = Number(v);
    else body[field.key] = String(v);
  }
  return body;
}

function FieldInput({
  field,
  value,
  onChange,
  options,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const id = `fld-${field.key}`;
  if (field.type === 'bool') {
    return (
      <label className="flex items-center gap-2 text-sm text-navy">
        <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }
  return (
    <div>
      <Label htmlFor={id} required={field.required}>
        {field.label}
      </Label>
      {field.type === 'select' ? (
        <Select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {!field.required && <option value="">—</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : field.type === 'textarea' ? (
        <textarea
          id={id}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:ring-2 focus:ring-electric/40"
          rows={3}
          value={String(value ?? '')}
          maxLength={field.max}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={field.type === 'int' || field.type === 'decimal' ? 'number' : field.type === 'email' ? 'email' : 'text'}
          step={field.type === 'decimal' ? 'any' : field.type === 'int' ? 1 : undefined}
          min={field.min}
          max={field.type === 'int' ? field.maxValue : undefined}
          maxLength={field.max}
          placeholder={field.placeholder}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.hint && <p className="mt-1 text-xs text-navy/50">{field.hint}</p>}
    </div>
  );
}

export function SimpleListEditor({ spec }: { spec: ListSpec }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyForm(spec));
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<Record<string, Entry[]>>(`${spec.endpoint}${spec.supportsInactiveQuery ? `?includeInactive=true` : ''}`);
      setEntries((data[spec.responseKey] ?? []) as Entry[]);
    } catch (err) {
      toastError(err, `Could not load ${spec.label}.`);
    } finally {
      setLoading(false);
    }
  }, [spec]);

  useEffect(() => {
    setEntries([]);
    setShowInactive(false);
    void load();
  }, [load]);

  const visible = useMemo(() => entries.filter((e) => showInactive || e.isActive), [entries, showInactive]);
  const parentOptions = useMemo(
    () => entries.filter((e) => e.isActive && e.id !== editing?.id).map((e) => ({ value: e.id, label: String(e[spec.nameField]) })),
    [entries, editing, spec.nameField],
  );

  function openAdd() {
    setEditing(null);
    setForm(emptyForm(spec));
    setFormOpen(true);
  }
  function openEdit(e: Entry) {
    setEditing(e);
    setForm(toForm(spec, e));
    setFormOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const body = toBody(spec, form, !!editing);
      if (editing) {
        if (spec.updateMethod === 'put') await api.put(`${spec.endpoint}/${editing.id}`, { ...body, isActive: editing.isActive });
        else await api.patch(`${spec.endpoint}/${editing.id}`, body);
        toast(`Saved.`, 'success');
      } else {
        await api.post(spec.endpoint, body);
        toast(`Added to ${spec.label}.`, 'success');
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      toastError(err, 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  async function setActive(e: Entry, isActive: boolean) {
    try {
      if (spec.updateMethod === 'put') await api.put(`${spec.endpoint}/${e.id}`, { ...toBody(spec, toForm(spec, e), true), isActive });
      else await api.patch(`${spec.endpoint}/${e.id}`, { isActive });
      await load();
    } catch (err) {
      toastError(err, 'Could not change the entry.');
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const r = await api.del<{ deleted: boolean; deactivated: boolean }>(`${spec.endpoint}/${deleteTarget.id}`);
      toast(r.deleted ? 'Deleted.' : 'This entry is in use, so it was made inactive instead of deleted.', r.deleted ? 'success' : 'info');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not delete.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-navy">{spec.label}</h2>
          <p className="mt-1 max-w-2xl text-sm text-navy/60">{spec.description}</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-navy/70">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" /> New
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-navy/50">
          <Spinner className="h-4 w-4" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <EmptyState title={`No ${spec.label.toLowerCase()} yet`} message={spec.emptyHint} action={<Button onClick={openAdd}>Add the first one</Button>} />
      ) : (
        <Table>
          <thead>
            <tr>
              {spec.columns.map((c) => (
                <Th key={c.key}>{c.label}</Th>
              ))}
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <Tr key={e.id}>
                {spec.columns.map((c) => (
                  <Td key={c.key}>{c.render ? c.render(e, entries) : String(e[c.key] ?? '')}</Td>
                ))}
                <Td>{e.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(e)} aria-label={`Edit ${String(e[spec.nameField])}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setActive(e, !e.isActive)}>
                    {e.isActive ? 'Make inactive' : 'Make active'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(e)} aria-label={`Delete ${String(e[spec.nameField])}`}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Edit ${spec.singular}` : `New ${spec.singular}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button loading={saving} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {spec.fields
            .filter((f) => !f.showIf || f.showIf(form))
            .map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={form[f.key]}
                onChange={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))}
                options={f.options === 'parent' ? parentOptions : f.options ?? []}
              />
            ))}
          {spec.preview && <p className="rounded-lg bg-electric/5 px-3 py-2 text-sm text-navy/70">{spec.preview(form)}</p>}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete ${spec.singular}?`}
        message={`If "${String(deleteTarget?.[spec.nameField] ?? '')}" is used anywhere it will be made inactive instead, so past records keep their details.`}
        confirmLabel="Delete"
        tone="danger"
        loading={deleting}
        onConfirm={remove}
        onClose={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
