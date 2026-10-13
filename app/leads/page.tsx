'use client';
/**
 * Lead Center (QB Customers > Lead Center): people and businesses you hope to sell to.
 * Keep their contact details, notes and to-dos here, then "Convert to customer" when they buy —
 * the lead becomes a customer and its open to-dos move with it. Leads never touch the books.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, Plus, Trash2, UserPlus, Users } from 'lucide-react';
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
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';

interface Contact {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
}
interface Lead {
  id: string;
  name: string;
  companyName: string | null;
  status: 'hot' | 'warm' | 'cold';
  email: string | null;
  phone: string | null;
  website: string | null;
  address: Record<string, string> | null;
  contacts: Contact[] | null;
  notes: string | null;
  convertedCustomerId: string | null;
  isActive: boolean;
}
interface Todo {
  id: string;
  title: string;
  dueDate: string | null;
  done: boolean;
}

const STATUS_TONE = { hot: 'danger', warm: 'warning', cold: 'info' } as const;

const EMPTY: Omit<Lead, 'id' | 'convertedCustomerId'> = {
  name: '',
  companyName: '',
  status: 'warm',
  email: '',
  phone: '',
  website: '',
  address: { line1: '', city: '', state: '', zip: '' },
  contacts: [],
  notes: '',
  isActive: true,
};

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [showConverted, setShowConverted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<Omit<Lead, 'id' | 'convertedCustomerId'> & { id?: string }>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTodo, setNewTodo] = useState({ title: '', dueDate: '' });
  const [convertOpen, setConvertOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const selected = useMemo(() => leads.find((l) => l.id === selectedId) ?? null, [leads, selectedId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLeads(await api.get<Lead[]>(`/api/leads${showConverted ? '?includeConverted=1' : ''}`));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load leads', 'danger');
    } finally {
      setLoading(false);
    }
  }, [showConverted]);

  const loadTodos = useCallback(async (leadId: string) => {
    try {
      setTodos((await api.get<{ todos: Todo[] }>(`/api/todos?includeDone=1&entityType=lead&entityId=${leadId}`)).todos);
    } catch {
      setTodos([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (selectedId) void loadTodos(selectedId);
    else setTodos([]);
  }, [selectedId, loadTodos]);

  function openNew() {
    setForm({ ...EMPTY, address: { ...EMPTY.address }, contacts: [] });
    setEditOpen(true);
  }
  function openEdit(l: Lead) {
    setForm({
      id: l.id,
      name: l.name,
      companyName: l.companyName ?? '',
      status: l.status,
      email: l.email ?? '',
      phone: l.phone ?? '',
      website: l.website ?? '',
      address: { line1: '', city: '', state: '', zip: '', ...(l.address ?? {}) },
      contacts: l.contacts ?? [],
      notes: l.notes ?? '',
      isActive: l.isActive,
    });
    setEditOpen(true);
  }

  async function save() {
    if (!form.name.trim()) {
      toast('A lead needs a name', 'danger');
      return;
    }
    setSaving(true);
    const body = {
      name: form.name.trim(),
      companyName: form.companyName || null,
      status: form.status,
      email: form.email || null,
      phone: form.phone || null,
      website: form.website || null,
      address: Object.fromEntries(Object.entries(form.address ?? {}).filter(([, v]) => v)),
      contacts: (form.contacts ?? []).filter((c) => c.name.trim()),
      notes: form.notes || null,
      isActive: form.isActive,
    };
    try {
      const saved = form.id
        ? await api.patch<Lead>(`/api/leads/${form.id}`, body)
        : await api.post<Lead>('/api/leads', body);
      setEditOpen(false);
      await load();
      setSelectedId(saved.id);
      toast('Lead saved', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the lead', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function convert() {
    if (!selected) return;
    setConverting(true);
    try {
      await api.post<{ customerId: string }>(`/api/leads/${selected.id}/convert`, {});
      setConvertOpen(false);
      toast(`${selected.companyName || selected.name} is now a customer`, 'success');
      await load();
      setSelectedId(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not convert the lead', 'danger');
    } finally {
      setConverting(false);
    }
  }

  async function remove() {
    if (!selected) return;
    try {
      await api.del(`/api/leads/${selected.id}`);
      setDeleteOpen(false);
      setSelectedId(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete the lead', 'danger');
    }
  }

  async function addTodo() {
    if (!selected || !newTodo.title.trim()) return;
    try {
      await api.post('/api/todos', {
        title: newTodo.title.trim(),
        dueDate: newTodo.dueDate || null,
        kind: 'call',
        entityType: 'lead',
        entityId: selected.id,
      });
      setNewTodo({ title: '', dueDate: '' });
      await loadTodos(selected.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add the to-do', 'danger');
    }
  }

  async function toggleTodo(t: Todo) {
    try {
      await api.patch(`/api/todos/${t.id}`, { done: !t.done });
      if (selected) await loadTodos(selected.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the to-do', 'danger');
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Lead Center"
        icon={Users}
        action={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" /> New lead
          </Button>
        }
      />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <Card className="w-full p-4 lg:w-80 lg:shrink-0">
          <label className="mb-3 flex items-center gap-2 text-xs text-navy/60">
            <input type="checkbox" checked={showConverted} onChange={(e) => setShowConverted(e.target.checked)} /> Show leads that became customers
          </label>
          {loading ? (
            <div className="flex justify-center py-6 text-electric">
              <Spinner className="h-5 w-5" />
            </div>
          ) : leads.length === 0 ? (
            <EmptyState icon={Users} title="No leads yet" message="Add the people and businesses you hope to sell to." />
          ) : (
            <ul className="flex flex-col gap-1">
              {leads.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(l.id)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${selectedId === l.id ? 'bg-electric text-white' : 'text-navy hover:bg-electric/10'} ${l.isActive || l.convertedCustomerId ? '' : 'opacity-50'}`}
                  >
                    <span className="truncate">{l.companyName || l.name}</span>
                    {l.convertedCustomerId ? <Badge tone="success">Customer</Badge> : <Badge tone={STATUS_TONE[l.status]}>{l.status}</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="min-w-0 flex-1">
          {!selected ? (
            <Card className="p-8 text-sm text-navy/50">Pick a lead to see its details, contacts and to-dos.</Card>
          ) : (
            <div className="flex flex-col gap-6">
              <Card className="p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-bold text-navy">{selected.companyName || selected.name}</h2>
                    {selected.companyName && <p className="text-sm text-navy/60">{selected.name}</p>}
                    <p className="mt-2 text-sm text-navy/70">
                      {[selected.email, selected.phone, selected.website].filter(Boolean).join(' · ') || 'No contact details yet'}
                    </p>
                    {selected.address && Object.values(selected.address).some(Boolean) && (
                      <p className="text-sm text-navy/60">{[selected.address.line1, selected.address.city, selected.address.state, selected.address.zip].filter(Boolean).join(', ')}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selected.convertedCustomerId ? (
                      <Link href="/customers" className="text-sm font-semibold text-electric hover:underline">
                        Open customer
                      </Link>
                    ) : (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => openEdit(selected)}>
                          Edit
                        </Button>
                        <Button size="sm" onClick={() => setConvertOpen(true)}>
                          <UserPlus className="h-4 w-4" /> Convert to customer
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)} aria-label="Delete lead">
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {selected.notes && <p className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-navy/80">{selected.notes}</p>}
              </Card>

              <Card className="p-6">
                <h3 className="mb-2 font-bold text-navy">Contacts</h3>
                {(selected.contacts ?? []).length === 0 ? (
                  <p className="text-sm text-navy/50">No contacts. Use Edit to add the people you talk to.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 text-sm">
                    {(selected.contacts ?? []).map((c, i) => (
                      <li key={i} className="py-1.5">
                        <span className="font-semibold text-navy">{c.name}</span>
                        {c.title && <span className="text-navy/50"> · {c.title}</span>}
                        <span className="ml-2 text-navy/60">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="p-6">
                <h3 className="mb-2 font-bold text-navy">To-dos</h3>
                <ul className="mb-3 flex flex-col gap-1.5">
                  {todos.map((t) => (
                    <li key={t.id}>
                      <button type="button" onClick={() => void toggleTodo(t)} className="flex items-center gap-2 text-left text-sm">
                        {t.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-navy/40" />}
                        <span className={t.done ? 'line-through text-navy/40' : 'text-navy'}>
                          {t.dueDate && <span className="mr-1 tabular-nums text-navy/40">{t.dueDate}</span>}
                          {t.title}
                        </span>
                      </button>
                    </li>
                  ))}
                  {todos.length === 0 && <li className="text-sm text-navy/50">No to-dos yet.</li>}
                </ul>
                {!selected.convertedCustomerId && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[200px] flex-1">
                      <Label htmlFor="lead-todo">Add a to-do</Label>
                      <Input id="lead-todo" spellCheck placeholder="e.g. Call back about the quote" value={newTodo.title} onChange={(e) => setNewTodo((t) => ({ ...t, title: e.target.value }))} />
                    </div>
                    <div>
                      <Label htmlFor="lead-todo-date">Due</Label>
                      <Input id="lead-todo-date" type="date" value={newTodo.dueDate} onChange={(e) => setNewTodo((t) => ({ ...t, dueDate: e.target.value }))} />
                    </div>
                    <Button size="sm" onClick={() => void addTodo()} disabled={!newTodo.title.trim()}>
                      Add
                    </Button>
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={form.id ? 'Edit Lead' : 'New Lead'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="lead-name">Name *</Label>
              <Input id="lead-name" autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="lead-company">Company</Label>
              <Input id="lead-company" value={form.companyName ?? ''} onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="lead-status">How likely to buy</Label>
              <Select id="lead-status" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as Lead['status'] }))}>
                <option value="hot">Hot</option>
                <option value="warm">Warm</option>
                <option value="cold">Cold</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="lead-email">Email</Label>
              <Input id="lead-email" type="email" value={form.email ?? ''} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="lead-phone">Phone</Label>
              <Input id="lead-phone" value={form.phone ?? ''} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="lead-web">Website</Label>
              <Input id="lead-web" value={form.website ?? ''} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {(['line1', 'city', 'state', 'zip'] as const).map((k) => (
              <div key={k} className={k === 'line1' ? 'col-span-4' : ''}>
                <Label htmlFor={`lead-addr-${k}`}>{k === 'line1' ? 'Street address' : k === 'zip' ? 'ZIP' : k[0].toUpperCase() + k.slice(1)}</Label>
                <Input
                  id={`lead-addr-${k}`}
                  value={form.address?.[k] ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, address: { ...(f.address ?? {}), [k]: e.target.value } }))}
                />
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label className="mb-0">Contacts</Label>
              <button type="button" className="text-xs font-semibold text-electric" onClick={() => setForm((f) => ({ ...f, contacts: [...(f.contacts ?? []), { name: '' }] }))}>
                + Add contact
              </button>
            </div>
            {(form.contacts ?? []).map((c, i) => (
              <div key={i} className="mb-2 grid grid-cols-4 gap-2">
                {(['name', 'title', 'email', 'phone'] as const).map((k) => (
                  <Input
                    key={k}
                    aria-label={`Contact ${i + 1} ${k}`}
                    placeholder={k[0].toUpperCase() + k.slice(1)}
                    value={c[k] ?? ''}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, contacts: (f.contacts ?? []).map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)) }))
                    }
                  />
                ))}
              </div>
            ))}
          </div>
          <div>
            <Label htmlFor="lead-notes">Notes</Label>
            <textarea id="lead-notes" rows={4} spellCheck value={form.notes ?? ''} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          </div>
          {form.id && (
            <label className="flex items-center gap-2 text-sm text-navy">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} /> Active
            </label>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={convertOpen}
        title="Convert to Customer"
        message={<>Make &quot;{selected?.companyName || selected?.name}&quot; a customer? Their details and open to-dos move to the new customer.</>}
        confirmLabel="Convert"
        loading={converting}
        onConfirm={() => void convert()}
        onClose={() => setConvertOpen(false)}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="Delete Lead"
        tone="danger"
        message={<>Delete &quot;{selected?.companyName || selected?.name}&quot; and its to-dos?</>}
        confirmLabel="Delete"
        onConfirm={() => void remove()}
        onClose={() => setDeleteOpen(false)}
      />
    </main>
  );
}
