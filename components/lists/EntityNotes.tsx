'use client';
/**
 * <EntityNotes entityType="customer" entityId={id} /> — dated notes on a customer, vendor,
 * employee or other name (newest first). Each note keeps its own date stamp, like QB's Notes.
 */
import { useCallback, useEffect, useState } from 'react';
import { NotebookText, Pencil, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog, DateInput, Spinner, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';

interface Note {
  id: string;
  body: string;
  noteDate: string;
  createdAt: string;
}

export function EntityNotes({
  entityType,
  entityId,
}: {
  entityType: 'customer' | 'vendor' | 'employee' | 'other_name';
  entityId: string;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [draftDate, setDraftDate] = useState(() => todayISO());
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ notes: Note[] }>(`/api/notes?entityType=${entityType}&entityId=${entityId}`);
      setNotes(data.notes);
    } catch (err) {
      toastError(err, 'Could not load notes.');
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      await api.post('/api/notes', { entityType, entityId, body: draft, noteDate: new Date(draftDate).toISOString() });
      setDraft('');
      await load();
    } catch (err) {
      toastError(err, 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    if (!editId) return;
    try {
      await api.patch(`/api/notes/${editId}`, { body: editBody });
      setEditId(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not save the note.');
    }
  }

  async function remove() {
    if (!deleteId) return;
    try {
      await api.del(`/api/notes/${deleteId}`);
      setDeleteId(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not delete the note.');
    }
  }

  return (
    <section aria-label="Notes" className="mt-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-navy">
        <NotebookText className="h-4 w-4 text-electric" /> Notes
      </h3>
      <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
        <textarea
          aria-label="New note"
          rows={2}
          placeholder="Add a note (it is stamped with the date below)"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:ring-2 focus:ring-electric/40"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="flex items-center justify-end gap-2">
          <DateInput aria-label="Note date" value={draftDate} onChange={(e) => setDraftDate(e.target.value)} className="w-40" />
          <Button size="sm" onClick={add} loading={saving} disabled={!draft.trim()}>
            Add note
          </Button>
        </div>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-navy/50">
          <Spinner className="h-4 w-4" /> Loading notes…
        </div>
      ) : notes.length === 0 ? (
        <p className="py-3 text-sm text-navy/50">No notes yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-navy">
              <div className="mb-1 flex items-center justify-between text-xs text-navy/50">
                <span>{new Date(n.noteDate).toLocaleDateString()}</span>
                <span>
                  <button type="button" aria-label="Edit note" className="mr-2 hover:text-navy" onClick={() => { setEditId(n.id); setEditBody(n.body); }}>
                    <Pencil className="inline h-3.5 w-3.5" />
                  </button>
                  <button type="button" aria-label="Delete note" className="hover:text-red-600" onClick={() => setDeleteId(n.id)}>
                    <Trash2 className="inline h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
              {editId === n.id ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    aria-label="Edit note text"
                    rows={3}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                  />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditId(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={saveEdit} disabled={!editBody.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{n.body}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!deleteId}
        title="Delete this note?"
        confirmLabel="Delete"
        tone="danger"
        onConfirm={remove}
        onClose={() => setDeleteId(null)}
      />
    </section>
  );
}
