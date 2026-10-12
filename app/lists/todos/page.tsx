'use client';
/**
 * To Do list — /lists/todos
 * Reminders (calls, meetings, tasks...) with a due date and priority, optionally about a
 * customer, vendor, employee, other name or item.
 */
import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Plus, Pencil, Trash2, Check } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
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
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';

interface Todo {
  id: string;
  title: string;
  details: string | null;
  type: string;
  priority: string;
  status: string;
  dueDate: string | null;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
}

interface Option {
  id: string;
  label: string;
}

const TYPES = ['task', 'call', 'email', 'meeting', 'appointment', 'fax'];
const PRIORITIES = ['high', 'medium', 'low'];
const LINKS: Array<{ value: string; label: string; url: string; pick: (d: unknown) => Option[] }> = [
  { value: 'customer', label: 'Customer', url: '/api/customers', pick: (d) => (d as Array<{ id: string; displayName: string }>).map((c) => ({ id: c.id, label: c.displayName })) },
  { value: 'vendor', label: 'Vendor', url: '/api/vendors', pick: (d) => (d as Array<{ id: string; displayName: string }>).map((c) => ({ id: c.id, label: c.displayName })) },
  { value: 'other_name', label: 'Other name', url: '/api/lists/other-names', pick: (d) => (d as { entries: Array<{ id: string; name: string }> }).entries.map((c) => ({ id: c.id, label: c.name })) },
  { value: 'item', label: 'Item', url: '/api/items', pick: (d) => (d as { items: Array<{ id: string; name: string }> }).items.map((c) => ({ id: c.id, label: c.name })) },
];

const EMPTY = { title: '', details: '', type: 'task', priority: 'medium', dueDate: '', entityType: '', entityId: '' };

function dateOnly(v: string | null) {
  return v ? v.slice(0, 10) : '';
}

export default function TodosPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [linkOptions, setLinkOptions] = useState<Option[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Todo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ todos: Todo[] }>(`/api/todos?status=${status}`);
      setTodos(data.todos);
    } catch (err) {
      toastError(err, 'Could not load the To Do list.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const link = LINKS.find((l) => l.value === form.entityType);
    if (!link) {
      setLinkOptions([]);
      return;
    }
    api
      .get<unknown>(link.url)
      .then((d) => setLinkOptions(link.pick(d)))
      .catch(() => setLinkOptions([]));
  }, [form.entityType]);

  function openAdd() {
    setEditing(null);
    setForm({ ...EMPTY });
    setFormOpen(true);
  }
  function openEdit(t: Todo) {
    setEditing(t);
    setForm({
      title: t.title,
      details: t.details ?? '',
      type: t.type,
      priority: t.priority,
      dueDate: dateOnly(t.dueDate),
      entityType: t.entityType ?? '',
      entityId: t.entityId ?? '',
    });
    setFormOpen(true);
  }

  async function save() {
    setSaving(true);
    const body = {
      title: form.title,
      details: form.details || null,
      type: form.type,
      priority: form.priority,
      dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
      entityType: form.entityType || null,
      entityId: form.entityType ? form.entityId || null : null,
    };
    try {
      if (editing) await api.patch(`/api/todos/${editing.id}`, body);
      else await api.post('/api/todos', body);
      toast('Saved.', 'success');
      setFormOpen(false);
      await load();
    } catch (err) {
      toastError(err, 'Could not save the to-do.');
    } finally {
      setSaving(false);
    }
  }

  async function markDone(t: Todo, done: boolean) {
    try {
      await api.patch(`/api/todos/${t.id}`, { status: done ? 'done' : 'open' });
      await load();
    } catch (err) {
      toastError(err, 'Could not update the to-do.');
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    try {
      await api.del(`/api/todos/${deleteTarget.id}`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not delete the to-do.');
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="To Do"
        icon={ClipboardCheck}
        action={
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" /> New to-do
          </Button>
        }
      />
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-3">
          <Label htmlFor="todo-status">Show</Label>
          <Select id="todo-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-40">
            <option value="open">Not done</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </Select>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-navy/50">
            <Spinner className="h-4 w-4" /> Loading…
          </div>
        ) : todos.length === 0 ? (
          <EmptyState icon={ClipboardCheck} title="Nothing to do" message="Add reminders to call a customer, chase a payment or reorder stock." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Done</Th>
                <Th>Due</Th>
                <Th>To do</Th>
                <Th>Kind</Th>
                <Th>Priority</Th>
                <Th>About</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {todos.map((t) => {
                const overdue = t.status === 'open' && t.dueDate && dateOnly(t.dueDate) < today;
                return (
                  <Tr key={t.id}>
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`Mark "${t.title}" done`}
                        checked={t.status === 'done'}
                        onChange={(e) => markDone(t, e.target.checked)}
                      />
                    </Td>
                    <Td className={overdue ? 'font-semibold text-red-600' : ''}>{dateOnly(t.dueDate) || '—'}</Td>
                    <Td>
                      <div className={t.status === 'done' ? 'line-through text-navy/40' : ''}>{t.title}</div>
                      {t.details && <div className="text-xs text-navy/50">{t.details}</div>}
                    </Td>
                    <Td className="capitalize">{t.type}</Td>
                    <Td>
                      <Badge tone={t.priority === 'high' ? 'danger' : t.priority === 'medium' ? 'warning' : 'neutral'}>{t.priority}</Badge>
                    </Td>
                    <Td>{t.entityName ?? ''}</Td>
                    <Td className="whitespace-nowrap text-right">
                      {t.status !== 'done' && (
                        <Button size="sm" variant="ghost" onClick={() => markDone(t, true)} aria-label="Mark done">
                          <Check className="h-4 w-4" />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => openEdit(t)} aria-label="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(t)} aria-label="Delete">
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit to-do' : 'New to-do'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button loading={saving} onClick={save} disabled={!form.title.trim()}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="todo-title" required>
              What needs doing?
            </Label>
            <Input id="todo-title" value={form.title} maxLength={255} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="todo-type">Kind</Label>
              <Select id="todo-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="todo-priority">Priority</Label>
              <Select id="todo-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="todo-due">Due</Label>
              <DateInput id="todo-due" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="todo-link">About a…</Label>
              <Select id="todo-link" value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value, entityId: '' })}>
                <option value="">Nothing in particular</option>
                {LINKS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </div>
            {form.entityType && (
              <div>
                <Label htmlFor="todo-entity" required>
                  Which one?
                </Label>
                <Select id="todo-entity" value={form.entityId} onChange={(e) => setForm({ ...form, entityId: e.target.value })}>
                  <option value="">Choose…</option>
                  {linkOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="todo-details">Details</Label>
            <textarea
              id="todo-details"
              rows={3}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:ring-2 focus:ring-electric/40"
              value={form.details}
              onChange={(e) => setForm({ ...form, details: e.target.value })}
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this to-do?"
        message={deleteTarget?.title}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={remove}
        onClose={() => setDeleteTarget(null)}
      />
    </main>
  );
}
