'use client';
import { useEffect, useMemo, useState } from 'react';
import { Archive, Building2, Check, Pencil, Plus, X } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Label,
  Modal,
  PageHeader,
  PageSkeleton,
  toast,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatDate } from '@/lib/utils';

interface Company {
  id: string;
  name: string;
  createdAt: string;
  settings?: {
    archived?: boolean;
    lastOpenedAt?: string;
    [key: string]: unknown;
  } | null;
}

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [renaming, setRenaming] = useState(false);

  // Archive confirm state (typed-name destructive confirm)
  const [archiveTarget, setArchiveTarget] = useState<Company | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [archiving, setArchiving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setCompanies(await api.get<Company[]>('/api/companies'));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to load', 'danger');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  // Hide archived files; order by last opened (most recent first), then created date.
  const visible = useMemo(() => {
    return companies
      .filter((c) => !c.settings?.archived)
      .sort((a, b) => {
        const ao = a.settings?.lastOpenedAt ?? '';
        const bo = b.settings?.lastOpenedAt ?? '';
        if (ao !== bo) return bo.localeCompare(ao);
        return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
      });
  }, [companies]);

  async function create() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const created = await api.post<{ id: string }>('/api/companies', { name });
      // Open the new company and run the setup interview for it (it offers Skip).
      await api.post('/api/companies/select', { companyId: created.id });
      toast('Company created', 'success');
      window.location.href = '/onboarding?new=1';
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function open_(id: string) {
    try {
      await api.post('/api/companies/select', { companyId: id });
      toast('Switched company', 'success');
      window.location.href = '/dashboard';
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    }
  }

  function startRename(c: Company) {
    setEditingId(c.id);
    setEditName(c.name);
  }

  async function saveRename() {
    if (!editingId) return;
    const next = editName.trim();
    if (!next) {
      toast('Company name is required', 'danger');
      return;
    }
    setRenaming(true);
    try {
      await api.patch(`/api/companies/${editingId}`, { name: next });
      toast('Company renamed', 'success');
      setEditingId(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Rename failed', 'danger');
    } finally {
      setRenaming(false);
    }
  }

  async function archive() {
    if (!archiveTarget) return;
    if (confirmName.trim() !== archiveTarget.name) {
      toast('Type the company name exactly to confirm', 'danger');
      return;
    }
    setArchiving(true);
    try {
      await api.del(
        `/api/companies/${archiveTarget.id}?confirm=${encodeURIComponent(confirmName.trim())}`,
      );
      toast('Company archived', 'success');
      setArchiveTarget(null);
      setConfirmName('');
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Archive failed', 'danger');
    } finally {
      setArchiving(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Companies"
        icon={Building2}
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New Company
          </Button>
        }
      />
      {loading ? (
        <PageSkeleton rows={4} />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={Building2}
            title="No companies yet"
            message="Create your first company file to get started."
            action={
              <Button onClick={() => setOpen(true)}>
                <Plus className="h-4 w-4" /> New Company
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {visible.map((c) => (
            <Card key={c.id} className="p-6 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-gradient-to-b from-electric/85 to-electric h-10 w-10 shrink-0 flex items-center justify-center">
                  <Building2 className="text-white h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  {editingId === c.id ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveRename();
                      }}
                    >
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        autoFocus
                        aria-label="Company name"
                      />
                      <Button type="submit" size="sm" loading={renaming} aria-label="Save name">
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingId(null)}
                        aria-label="Cancel rename"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </form>
                  ) : (
                    <div className="flex items-center gap-1">
                      <div className="font-bold text-navy truncate">{c.name}</div>
                      <button
                        type="button"
                        className="text-navy/40 hover:text-navy p-1"
                        onClick={() => startRename(c)}
                        title="Rename company"
                        aria-label={`Rename ${c.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  <div className="text-xs text-navy/40">
                    {c.settings?.lastOpenedAt
                      ? `Last opened ${formatDate(c.settings.lastOpenedAt)}`
                      : `Created ${formatDate(c.createdAt)}`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" className="flex-1" onClick={() => open_(c.id)}>
                  <Check className="h-4 w-4" /> Open
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirmName('');
                    setArchiveTarget(c);
                  }}
                  title="Archive company"
                  aria-label={`Archive ${c.name}`}
                >
                  <Archive className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New Company"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="new-company-form" loading={saving}>
              Create
            </Button>
          </>
        }
      >
        <form
          id="new-company-form"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <Label htmlFor="company-name">Company name</Label>
          <Input id="company-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." autoFocus />
          <p className="mt-2 text-xs text-navy/40">A default Chart of Accounts will be created for you.</p>
        </form>
      </Modal>

      <ConfirmDialog
        open={archiveTarget !== null}
        title="Archive company"
        tone="danger"
        confirmLabel="Archive"
        loading={archiving}
        onClose={() => {
          setArchiveTarget(null);
          setConfirmName('');
        }}
        onConfirm={archive}
        message={
          archiveTarget ? (
            <span className="block space-y-3">
              <span className="block">
                Archiving hides <strong>{archiveTarget.name}</strong> from your company list. Your
                books are preserved and the file can be restored later. To confirm, type the
                company name exactly:
              </span>
              <Input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={archiveTarget.name}
                autoFocus
                aria-label="Type the company name to confirm"
              />
            </span>
          ) : null
        }
      />
    </main>
  );
}
