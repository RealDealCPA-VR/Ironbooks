'use client';
/**
 * Calendar (QB Company > Calendar) + To Do list.
 *
 * A month at a glance: transactions entered each day, what is due (invoices, bills, estimates
 * expiring, purchase orders expected), memorized transactions scheduled to enter, and to-dos.
 * Click a day to see everything on it or add a to-do.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Circle, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, Input, Label, Modal, PageHeader, Select, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { usePreferences } from '@/lib/usePreferences';

interface CalendarEvent {
  id: string;
  kind: string;
  type: 'entered' | 'due' | 'todo' | 'scheduled';
  label: string;
  amount: string | null;
  href: string;
  done?: boolean;
  overdue?: boolean;
}
interface CalendarDay {
  date: string;
  events: CalendarEvent[];
}
interface Todo {
  id: string;
  title: string;
  notes: string | null;
  kind: string;
  priority: string;
  dueDate: string | null;
  dueTime: string | null;
  done: boolean;
}

const TYPE_STYLE: Record<CalendarEvent['type'], string> = {
  entered: 'bg-electric/10 text-electric',
  due: 'bg-gold/15 text-amber-700',
  todo: 'bg-emerald-100 text-emerald-700',
  scheduled: 'bg-purple-100 text-purple-700',
};
const TYPE_LABEL: Record<CalendarEvent['type'], string> = {
  entered: 'Entered',
  due: 'Due',
  todo: 'To-do',
  scheduled: 'Scheduled',
};

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function CalendarPage() {
  const { today, company } = usePreferences();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [days, setDays] = useState<Record<string, CalendarEvent[]>>({});
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState<Record<CalendarEvent['type'], boolean>>({ entered: true, due: true, todo: true, scheduled: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [todoOpen, setTodoOpen] = useState(false);
  const [todoForm, setTodoForm] = useState({ title: '', dueDate: '', dueTime: '', kind: 'task', priority: 'medium', notes: '' });
  const [savingTodo, setSavingTodo] = useState(false);

  const weekStartsMonday = company.firstDayOfWeek === 'monday';
  const grid = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() - (weekStartsMonday ? 1 : 0) + 7) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [month, weekStartsMonday]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ days: CalendarDay[] }>(`/api/calendar?from=${iso(grid[0])}&to=${iso(grid[41])}`);
      setDays(Object.fromEntries(res.days.map((d) => [d.date, d.events])));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the calendar', 'danger');
    } finally {
      setLoading(false);
    }
  }, [grid]);

  const loadTodos = useCallback(async () => {
    try {
      setTodos(await api.get<Todo[]>('/api/todos'));
    } catch {
      setTodos([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const weekdays = weekStartsMonday
    ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function openTodo(date: string) {
    setTodoForm({ title: '', dueDate: date, dueTime: '', kind: 'task', priority: 'medium', notes: '' });
    setTodoOpen(true);
  }

  async function saveTodo() {
    if (!todoForm.title.trim()) {
      toast('Describe the to-do first', 'danger');
      return;
    }
    setSavingTodo(true);
    try {
      await api.post('/api/todos', {
        title: todoForm.title.trim(),
        dueDate: todoForm.dueDate || null,
        dueTime: todoForm.dueTime || null,
        kind: todoForm.kind,
        priority: todoForm.priority,
        notes: todoForm.notes || null,
      });
      setTodoOpen(false);
      await Promise.all([load(), loadTodos()]);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the to-do', 'danger');
    } finally {
      setSavingTodo(false);
    }
  }

  async function toggleTodo(id: string, done: boolean) {
    try {
      await api.patch(`/api/todos/${id}`, { done });
      await Promise.all([load(), loadTodos()]);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the to-do', 'danger');
    }
  }

  async function deleteTodo(id: string) {
    try {
      await api.del(`/api/todos/${id}`);
      await Promise.all([load(), loadTodos()]);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete the to-do', 'danger');
    }
  }

  const selectedEvents = selected ? (days[selected] ?? []).filter((e) => show[e.type]) : [];

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Calendar"
        icon={CalendarDays}
        action={
          <Button onClick={() => openTodo(today)}>
            <Plus className="h-4 w-4" /> Add to-do
          </Button>
        }
      />

      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <Card className="min-w-0 flex-1 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" aria-label="Previous month" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <h2 className="w-44 text-center text-lg font-bold text-navy">
                {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </h2>
              <Button variant="ghost" size="sm" aria-label="Next month" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setSelected(today); }}>
                Today
              </Button>
              {loading && <Spinner className="h-4 w-4 text-electric" />}
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {(Object.keys(TYPE_LABEL) as CalendarEvent['type'][]).map((t) => (
                <label key={t} className={`flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 font-semibold ${TYPE_STYLE[t]}`}>
                  <input type="checkbox" checked={show[t]} onChange={(e) => setShow((s) => ({ ...s, [t]: e.target.checked }))} className="h-3 w-3" />
                  {TYPE_LABEL[t]}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 text-xs">
            {weekdays.map((w) => (
              <div key={w} className="bg-slate-50 px-2 py-1 text-center font-semibold text-navy/60">
                {w}
              </div>
            ))}
            {grid.map((d) => {
              const key = iso(d);
              const evs = (days[key] ?? []).filter((e) => show[e.type]);
              const inMonth = d.getMonth() === month.getMonth();
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelected(key)}
                  className={`flex min-h-[92px] flex-col gap-0.5 bg-white p-1.5 text-left align-top hover:bg-electric/5 ${inMonth ? '' : 'opacity-40'} ${selected === key ? 'ring-2 ring-inset ring-electric' : ''}`}
                >
                  <span className={`mb-0.5 text-[11px] font-bold ${key === today ? 'rounded-full bg-electric px-1.5 text-white' : 'text-navy/70'}`}>
                    {d.getDate()}
                  </span>
                  {evs.slice(0, 3).map((e, i) => (
                    <span key={`${e.id}-${i}`} className={`truncate rounded px-1 ${TYPE_STYLE[e.type]} ${e.done ? 'line-through opacity-60' : ''} ${e.overdue ? 'font-bold' : ''}`}>
                      {e.label}
                    </span>
                  ))}
                  {evs.length > 3 && <span className="text-[10px] text-navy/50">+{evs.length - 3} more</span>}
                </button>
              );
            })}
          </div>
        </Card>

        <div className="flex w-full flex-col gap-6 xl:w-96 xl:shrink-0">
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-bold text-navy">{selected ? new Date(`${selected}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'Pick a day'}</h3>
              {selected && (
                <Button size="sm" variant="ghost" onClick={() => openTodo(selected)}>
                  <Plus className="h-3.5 w-3.5" /> To-do
                </Button>
              )}
            </div>
            {selected && selectedEvents.length === 0 && <p className="text-sm text-navy/50">Nothing on this day.</p>}
            <ul className="flex flex-col gap-1.5">
              {selectedEvents.map((e, i) => (
                <li key={`${e.id}-${i}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone={e.type === 'due' ? (e.overdue ? 'danger' : 'warning') : e.type === 'todo' ? 'success' : 'info'}>{TYPE_LABEL[e.type]}</Badge>
                    <Link href={e.href} className={`truncate text-navy hover:text-electric hover:underline ${e.done ? 'line-through opacity-60' : ''}`}>
                      {e.label}
                    </Link>
                  </span>
                  {e.amount !== null && <span className="shrink-0 tabular-nums text-navy/70">{formatCurrency(e.amount)}</span>}
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-4">
            <h3 className="mb-2 font-bold text-navy">To Do list</h3>
            {todos.length === 0 ? (
              <p className="text-sm text-navy/50">No open to-dos.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {todos.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                    <button type="button" onClick={() => void toggleTodo(t.id, !t.done)} className="flex min-w-0 items-center gap-2 text-left" title="Mark done">
                      {t.done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : <Circle className="h-4 w-4 shrink-0 text-navy/40" />}
                      <span className={`truncate ${t.dueDate && t.dueDate < today ? 'font-semibold text-red-600' : 'text-navy'}`}>
                        {t.dueDate && <span className="mr-1 tabular-nums text-navy/40">{t.dueDate}</span>}
                        {t.title}
                      </span>
                    </button>
                    <button type="button" onClick={() => void deleteTodo(t.id)} className="rounded p-1 text-red-400 hover:bg-red-50" aria-label="Delete to-do">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Modal
        open={todoOpen}
        onClose={() => setTodoOpen(false)}
        title="New To-do"
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTodoOpen(false)} disabled={savingTodo}>
              Cancel
            </Button>
            <Button onClick={() => void saveTodo()} loading={savingTodo}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="todo-title">What needs doing?</Label>
            <Input id="todo-title" autoFocus spellCheck value={todoForm.title} onChange={(e) => setTodoForm((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="todo-date">Due date</Label>
              <Input id="todo-date" type="date" value={todoForm.dueDate} onChange={(e) => setTodoForm((f) => ({ ...f, dueDate: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="todo-time">Time (optional)</Label>
              <Input id="todo-time" type="time" value={todoForm.dueTime} onChange={(e) => setTodoForm((f) => ({ ...f, dueTime: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="todo-kind">Type</Label>
              <Select id="todo-kind" value={todoForm.kind} onChange={(e) => setTodoForm((f) => ({ ...f, kind: e.target.value }))}>
                <option value="task">Task</option>
                <option value="call">Call</option>
                <option value="meeting">Meeting</option>
                <option value="email">Email</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="todo-priority">Priority</Label>
              <Select id="todo-priority" value={todoForm.priority} onChange={(e) => setTodoForm((f) => ({ ...f, priority: e.target.value }))}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="todo-notes">Notes</Label>
            <textarea id="todo-notes" rows={3} spellCheck value={todoForm.notes} onChange={(e) => setTodoForm((f) => ({ ...f, notes: e.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          </div>
        </div>
      </Modal>
    </main>
  );
}
