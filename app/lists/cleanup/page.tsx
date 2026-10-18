'use client';
/**
 * Clean Up Company Data (lists) — /lists/cleanup
 * Shows the INACTIVE list entries that nothing in the company file uses, and removes the ones
 * you tick. Entries that are used anywhere (documents, prices, notes, other lists…) never appear
 * here, and every removal is re-checked when you press Remove. Your books are not changed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eraser } from 'lucide-react';
import { Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';

interface Entry {
  list: string;
  id: string;
  name: string;
}
interface Preview {
  lists: Array<{ list: string; label: string; entries: Entry[] }>;
  total: number;
}

export default function CleanupPage() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.get<Preview>('/api/cleanup');
      setPreview(p);
      setSelected(new Set(p.lists.flatMap((l) => l.entries.map((e) => e.id))));
    } catch (err) {
      toastError(err, 'Could not look for unused entries.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => (preview?.lists ?? []).filter((l) => l.entries.length > 0), [preview]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run() {
    setRunning(true);
    try {
      const res = await api.post<{ removed: Entry[]; kept: Array<Entry & { reason: string }> }>('/api/cleanup', {
        ids: [...selected],
        lists: groups.map((g) => g.list),
      });
      toast(
        `Removed ${res.removed.length} unused entr${res.removed.length === 1 ? 'y' : 'ies'}` +
          (res.kept.length ? `; kept ${res.kept.length} that are now in use.` : '.'),
        'success',
      );
      setConfirm(false);
      await load();
    } catch (err) {
      toastError(err, 'Clean up failed.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Clean Up Lists"
        icon={Eraser}
        action={
          <Button variant="danger" disabled={selected.size === 0 || loading} onClick={() => setConfirm(true)}>
            Remove {selected.size} selected
          </Button>
        }
      />
      <Card className="p-6">
        <p className="mb-4 max-w-3xl text-sm text-navy/60">
          These entries are marked inactive and nothing in your company file uses them — no transactions, prices, notes or
          other list entries. Removing them only tidies your lists; your books and reports do not change. Entries that are in
          use are never listed here.
        </p>
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-navy/50">
            <Spinner className="h-4 w-4" /> Checking every list…
          </div>
        ) : groups.length === 0 ? (
          <EmptyState icon={Eraser} title="Nothing to clean up" message="There are no unused inactive entries in your lists." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => (
              <div key={g.list} className="rounded-xl border border-slate-200 p-4">
                <h2 className="mb-2 font-semibold text-navy">
                  {g.label} <span className="text-sm font-normal text-navy/50">({g.entries.length})</span>
                </h2>
                <ul className="flex flex-col gap-1">
                  {g.entries.map((e) => (
                    <li key={e.id}>
                      <label className="flex items-center gap-2 text-sm text-navy">
                        <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                        {e.name || '(no name)'}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={confirm}
        title="Remove unused list entries?"
        message={`${selected.size} inactive, unused entr${selected.size === 1 ? 'y' : 'ies'} will be permanently removed. Each one is checked again first; anything that has become used is kept. This cannot be undone (a backup restores them).`}
        confirmLabel="Remove"
        tone="danger"
        loading={running}
        onConfirm={run}
        onClose={() => setConfirm(false)}
      />
    </main>
  );
}
