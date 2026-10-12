'use client';
/**
 * To Do list — /todos (QB Company > To Do List).
 *
 * THE one list of calls, faxes, emails, meetings, appointments and tasks. The same to-dos show on
 * the Calendar, in Reminders, in the Lead Center and on customer / vendor / employee records
 * (lib/services/todos.ts). ?new=1 opens the "New to-do" form.
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
import { useMe } from '@/lib/usePermissions';
import { usePreferences } from '@/lib/usePreferences';

interface Todo {
  id: string;
  title: string;
  notes: string | null;
  kind: string;
  priority: string;
  status: 'open' | 'done' | 'inactive';
  dueDate: string | null;
  dueTime: string | null;
  remindOn: string | null;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
  assignedUserId: string | null;
}

interface Option {
  id: string;
  label: string;
}

const KINDS = ['task', 'call', 'email', 'meeting', 'appointment', 'fax'];
const PRIORITIES = ['high', 'medium', 'low'];
type Named = Array<{ id: string; displayName?: string; name?: string; firstName?: string; lastName?: string }>;
const nameOf = (r: Named[number]) => r.displayName ?? r.name ?? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
const LINKS: Array<{ value: string; label: string; url: string; pick: (d: unknown) => Option[] }> = [
  { value: 'customer', label: 'Customer', url: '/api/customers', pick: (d) => (d as Named).map((c) => ({ id: c.id, label: nameOf(c) })) },
  { value: 'vendor', label: 'Vendor', url: '/api/vendors', pick: (d) => (d as Named).map((c) => ({ id: c.id, label: nameOf(c) })) },
  { value: 'employee', label: 'Employee', url: '/api/employees', pick: (d) => (d as Named).map((c) => ({ id: c.id, label: nameOf(c) })) },
  { value: 'lead', label: 'Lead', url: '/api/leads', pick: (d) => (d as Named).map((c) => ({ id: c.id, label: nameOf(c) })) },
  { value: 'other_name', label: 'Other name', url: '/api/lists/other-names', pick: (d) => (d as { entries: Named }).entries.map((c) => ({ id: c.id, label: nameOf(c) })) },
  { value: 'item', label: 'Item', url: '/api/items', pick: (d) => (d as { items: Named }).items.map((c) => ({ id: c.id, label: nameOf(c) })) },
];
const LINK_LABEL = Object.fromEntries(LINKS.map((l) => [l.value, l.label]));

const EMPTY = {
  title: '',
  notes: '',
  kind: 'task',
  priority: 'medium',
  dueDate: '',
  dueTime: '',
  remindOn: '',
  status: 'open' as Todo['status'],
  entityType: '',
  entityId: '',
  assignedUserId: '',
};

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function TodoListPage() {
  const prefs = usePreferences();
  const { me } = useMe();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'open' | 'done' | 'inactive' | 'all'>('open');
  const [mine, setMine] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [linkOptions, setLinkOptions] = useState<Option[]>([]);
  const [users, setUsers] = useState<Option[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Todo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ status });
      if (mine && me?.id) q.set('assignedUserId', me.id);
      const data = await api.get<{ todos: Todo[] }>(`/api/todos?${q}`);
      setTodos(data.todos);
    } catch (err) {
      toastError(err, 'Could not load the To Do list.');
    } finally {
      setLoading(false);
    }
  }, [status, mine, me?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // ?new=1 (Simple-mode links, palette) opens the form straight away.
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1') openAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // People a to-do can be assigned to: the user list when this member may see it, else just "me".
  useEffect(() => {
    api
      .get<Array<{ userId: string; name: string; isActive: boolean }>>('/api/users')
      .then((rows) => setUsers(rows.filter((u) => u.isActive).map((u) => ({ id: u.userId, label: u.name }))))
      .catch(() => setUsers(me?.id ? [{ id: me.id, label: me.name || me.email || 'Me' }] : []));
  }, [me?.id, me?.name, me?.email]);

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
      notes: t.notes ?? '',
      kind: t.kind,
      priority: t.priority,
      dueDate: t.dueDate ?? '',
      dueTime: t.dueTime ?? '',
      remindOn: t.remindOn ?? '',
      status: t.status,
      entityType: t.entityType ?? '',
      entityId: t.entityId ?? '',
      assignedUserId: t.assignedUserId ?? '',
    });
    setFormOpen(true);
  }

  async function save() {
    setSaving(true);
    const body = {
      title: form.title,
      notes: form.notes || null,
      kind: form.kind,
      priority: form.priority,
      dueDate: form.dueDate || null,
      dueTime: form.dueTime || null,
      remindOn: form.remindOn || null,
      status: form.status,
      entityType: form.entityType || null,
      entityId: form.entityType ? form.entityId || null : null,
      assignedUserId: form.assignedUserId || null,
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

  const today = prefs.today;
  const userName = (id: string | null) => (id ? (users.find((u) => u.id === id)?.label ?? '') : '');

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="To Do list"
        icon={ClipboardCheck}
        action={
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" /> New to-do
          </Button>
        }
      />
      <Card className="p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Label htmlFor="todo-status">Show</Label>
          <Select id="todo-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-40">
            <option value="open">Not done</option>
            <option value="done">Done</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </Select>
          <label className="flex items-center gap-2 text-sm text-navy/70">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only to-dos assigned to me
          </label>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-navy/50">
            <Spinner className="h-4 w-4" /> Loading…
          </div>
        ) : todos.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="Nothing to do"
            message="Add a reminder to call a customer, chase a payment or reorder stock. To-dos also show on the Calendar and in Reminders."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Done</Th>
                <Th>Due</Th>
                <Th>To do</Th>
                <Th>Type</Th>
                <Th>Priority</Th>
                <Th>About</Th>
                <Th>Assigned to</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {todos.map((t) => {
                const overdue = t.status === 'open' && !!t.dueDate && t.dueDate < today;
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
                    <Td className={overdue ? 'font-semibold text-red-600' : ''}>
                      {t.dueDate ?? '—'}
                      {t.dueTime && <span className="ml-1 text-xs text-navy/50">{t.dueTime}</span>}
                    </Td>
                    <Td>
                      <div className={t.status === 'done' ? 'line-through text-navy/40' : ''}>{t.title}</div>
                      {t.notes && <div className="text-xs text-navy/50">{t.notes}</div>}
                      {t.status === 'inactive' && <Badge tone="neutral">Inactive</Badge>}
                    </Td>
                    <Td>{cap(t.kind)}</Td>
                    <Td>
                      <Badge tone={t.priority === 'high' ? 'danger' : t.priority === 'medium' ? 'warning' : 'neutral'}>{cap(t.priority)}</Badge>
                    </Td>
                    <Td>
                      {t.entityName ? (
                        <span>
                          {t.entityName}
                          <span className="ml-1 text-xs text-navy/40">{LINK_LABEL[t.entityType ?? ''] ?? ''}</span>
                        </span>
                      ) : (
                        ''
                      )}
                    </Td>
                    <Td>{userName(t.assignedUserId)}</Td>
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
            <Button loading={saving} onClick={save} disabled={!form.title.trim() || (!!form.entityType && !form.entityId)}>
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
              <Label htmlFor="todo-kind">Type</Label>
              <Select id="todo-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {cap(k)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="todo-priority">Priority</Label>
              <Select id="todo-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {cap(p)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="todo-status-edit">Status</Label>
              <Select id="todo-status-edit" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Todo['status'] })}>
                <option value="open">Not done</option>
                <option value="done">Done</option>
                <option value="inactive">Inactive</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="todo-due">Due date</Label>
              <DateInput id="todo-due" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="todo-time">Time</Label>
              <Input id="todo-time" type="time" value={form.dueTime} onChange={(e) => setForm({ ...form, dueTime: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="todo-remind">Remind me on</Label>
              <DateInput id="todo-remind" value={form.remindOn} onChange={(e) => setForm({ ...form, remindOn: e.target.value })} />
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
            <Label htmlFor="todo-assigned">Assigned to</Label>
            <Select id="todo-assigned" value={form.assignedUserId} onChange={(e) => setForm({ ...form, assignedUserId: e.target.value })}>
              <option value="">Nobody in particular</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="todo-notes">Details</Label>
            <textarea
              id="todo-notes"
              rows={3}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:ring-2 focus:ring-electric/40"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
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
