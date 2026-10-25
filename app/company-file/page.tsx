'use client';
/**
 * Company File management — the QuickBooks-Desktop-style "your file lives wherever you put it"
 * surface. Shows the open company file (a single "ABC Company.ironbooks" file you can copy, back
 * up and keep on the office file server, or a company folder from an older version, with the
 * offer to turn it into a single file), whether it is saved, the recent files, sharing it on a
 * file server, and the optional file-open password (enforced server-side, every build).
 */
import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, FilePlus2, Lock, Unlock, HardDrive, Copy, FileArchive, Network, Save } from 'lucide-react';
import { Button, Card, Input, Label, Modal, PageHeader, Badge, toast } from '@/components/ui';
import { CompanyFileStatus } from '@/components/CompanyFileStatus';
import ShareCompanyFileCard from './ShareCompanyFileCard';

interface CurrentFile {
  dir: string;
  name: string;
  passwordProtected: boolean;
  /** A single company file (current format) rather than a company folder (older format). */
  singleFile?: boolean;
  /** Office-network multi-user mode is on (others are working in this file through this computer). */
  multiUser?: boolean;
}
interface RecentFile {
  dir: string;
  name: string;
  current: boolean;
}
interface CompanyBridge {
  isDesktop?: boolean;
  company?: {
    current: () => Promise<CurrentFile>;
    recent: () => Promise<RecentFile[]>;
    newFile: () => Promise<unknown>;
    open: () => Promise<unknown>;
    switch: (dir: string) => Promise<unknown>;
    setProtected: (val: boolean) => Promise<unknown>;
    reveal?: () => Promise<unknown>;
    saveNow?: () => Promise<unknown>;
    saveCopyAs?: (opts?: { convert?: boolean }) => Promise<unknown>;
  };
}

function bridge(): CompanyBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: CompanyBridge }).bookkeeper;
}

export default function CompanyFilePage() {
  const [desktop, setDesktop] = useState(false);
  const [current, setCurrent] = useState<CurrentFile | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [lock, setLock] = useState<{ enabled: boolean; companyName: string | null } | null>(null);
  const [modal, setModal] = useState<null | 'set' | 'change' | 'remove'>(null);

  const loadLock = useCallback(async () => {
    try {
      const res = await fetch('/api/file-lock');
      if (res.ok) setLock(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const b = bridge();
    setDesktop(Boolean(b?.isDesktop));
    if (b?.isDesktop && b.company) {
      b.company.current().then(setCurrent).catch(() => {});
      b.company.recent().then(setRecent).catch(() => {});
    }
    loadLock();
  }, [loadLock]);

  async function afterLockChange(enabled: boolean) {
    setModal(null);
    await loadLock();
    // Keep the desktop manifest's lock hint in sync (for Open/Recent icons).
    bridge()?.company?.setProtected?.(enabled).catch(() => {});
    if (current) setCurrent({ ...current, passwordProtected: enabled });
  }

  return (
    <div className="p-8 max-w-3xl mx-auto w-full">
      <PageHeader title="Company File" icon={HardDrive} />

      {desktop && (
        <Card className="p-6 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-navy/60">This company file</p>
              <p className="text-lg font-bold text-navy truncate">{current?.name ?? '—'}</p>
              {current?.dir && (
                <p className="font-mono text-xs text-navy/50 break-all select-text" title={current.dir}>
                  {current.dir}
                </p>
              )}
              {current?.singleFile && (
                <div className="mt-2 flex items-center gap-2 text-xs text-navy/60">
                  <CompanyFileStatus className="-ml-2" />
                  <span>Ironbooks saves every change into this file a few seconds after you make it, and when you close it.</span>
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
              <Button variant="secondary" onClick={() => bridge()?.company?.newFile?.()}>
                <FilePlus2 className="h-4 w-4" /> New Company…
              </Button>
              <Button variant="secondary" onClick={() => bridge()?.company?.open?.()}>
                <FolderOpen className="h-4 w-4" /> Open or Restore…
              </Button>
            </div>
          </div>

          {current && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => bridge()?.company?.reveal?.()}>
                <FolderOpen className="h-4 w-4" /> Show in folder
              </Button>
              {current.singleFile && (
                <Button size="sm" variant="ghost" onClick={() => bridge()?.company?.saveNow?.()}>
                  <Save className="h-4 w-4" /> Save now
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => bridge()?.company?.saveCopyAs?.()}>
                <Copy className="h-4 w-4" /> Save a copy…
              </Button>
            </div>
          )}

          {current && current.singleFile === false && (
            <div className="mt-5 rounded-xl border border-electric/25 bg-electric/[.06] p-4">
              <p className="flex items-center gap-2 font-semibold text-navy">
                <FileArchive className="h-4 w-4 text-electric" /> Make this a single company file
              </p>
              <p className="mt-1 text-sm text-navy/70">
                This company is stored as a folder, the format older versions of Ironbooks used. Save it as one
                file — like a QuickBooks .QBW — that you can copy to a USB drive, keep on your office file server
                and share with your accountant. Your user names and passwords go with it.
              </p>
              <Button className="mt-3" size="sm" onClick={() => bridge()?.company?.saveCopyAs?.({ convert: true })}>
                Save as a single company file…
              </Button>
            </div>
          )}

          {recent.length > 1 && (
            <div className="mt-6">
              <p className="text-sm font-semibold text-navy/70 mb-2">Recent files</p>
              <div className="divide-y divide-slate-100">
                {recent.map((r) => (
                  <div key={r.dir} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-navy truncate">
                        {r.name} {r.current && <Badge tone="info">current</Badge>}
                      </p>
                      <p className="text-xs text-navy/40 truncate" title={r.dir}>
                        {r.dir}
                      </p>
                    </div>
                    {!r.current && (
                      <Button size="sm" variant="ghost" onClick={() => bridge()?.company?.switch?.(r.dir)}>
                        Open
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {desktop && current?.singleFile && (
        <Card className="p-6 mb-6">
          <p className="flex items-center gap-2 text-lg font-bold text-navy">
            <Network className="h-5 w-5 text-electric" /> Working from a file server
          </p>
          <div className="mt-2 space-y-2 text-sm text-navy/70">
            <p>
              Keep the company file on a shared drive (for example <span className="font-mono">S:\Accounting</span> or{' '}
              <span className="font-mono">\\SERVER\Books</span>) and open it from any computer with Ironbooks.
            </p>
            <p>
              While someone has it open, it is locked: anyone else who opens it sees who is in it and can ask to come in.
              The person in the file chooses <b>Let Them In</b> (both work at the same time — multi-user mode on your office
              network, each with their own user name), <b>Hand It Over</b>, or <b>Not Now</b>.
            </p>
            <p>
              {current.multiUser
                ? 'Multi-user mode is on: others on your network are joining through this computer, so keep Ironbooks open here while they work.'
                : 'To let people join without asking, choose File > Switch to Multi-user Mode.'}
            </p>
          </div>
        </Card>
      )}

      {/* Portable company file, shareable ledger, transaction log. */}
      <ShareCompanyFileCard />

      {/* Password protection — works in every build; enforced server-side. */}
      <Card className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-bold text-navy flex items-center gap-2">
              {lock?.enabled ? (
                <Lock className="h-5 w-5 text-emerald" />
              ) : (
                <Unlock className="h-5 w-5 text-navy/40" />
              )}
              File password
            </p>
            <p className="text-sm text-navy/60 mt-1 max-w-md">
              {lock?.enabled
                ? 'An extra password is asked when this company file is opened, before each person signs in with their own user name.'
                : 'Everyone already signs in with their own user name and password, stored in this company file. Add a file password if you also want one shared password asked before that.'}
            </p>
          </div>
          <Badge tone={lock?.enabled ? 'success' : 'neutral'}>
            {lock?.enabled ? 'Protected' : 'Not protected'}
          </Badge>
        </div>
        <div className="mt-4 flex gap-2">
          {lock?.enabled ? (
            <>
              <Button variant="secondary" onClick={() => setModal('change')}>
                Change password
              </Button>
              <Button variant="danger" onClick={() => setModal('remove')}>
                Remove password
              </Button>
            </>
          ) : (
            <Button onClick={() => setModal('set')}>Set a password</Button>
          )}
        </div>
      </Card>

      {modal && (
        <FileLockModal
          mode={modal}
          onClose={() => setModal(null)}
          onDone={afterLockChange}
        />
      )}
    </div>
  );
}

function FileLockModal({
  mode,
  onClose,
  onDone,
}: {
  mode: 'set' | 'change' | 'remove';
  onClose: () => void;
  onDone: (enabled: boolean) => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const title =
    mode === 'set' ? 'Set file password' : mode === 'change' ? 'Change file password' : 'Remove file password';

  async function submit() {
    if (mode !== 'remove') {
      if (next.length < 4) return toast('Password must be at least 4 characters.', 'danger');
      if (next !== confirm) return toast('Passwords do not match.', 'danger');
    }
    setSaving(true);
    try {
      const body =
        mode === 'remove'
          ? { action: 'remove', currentPassword: current }
          : { action: 'set', password: next, currentPassword: mode === 'change' ? current : undefined };
      const res = await fetch('/api/file-lock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not update the file password.');
      }
      toast(mode === 'remove' ? 'File password removed.' : 'File password saved.', 'success');
      onDone(mode !== 'remove');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'danger');
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant={mode === 'remove' ? 'danger' : 'primary'} onClick={submit} loading={saving}>
            {mode === 'remove' ? 'Remove' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {mode !== 'set' && (
          <div>
            <Label htmlFor="cur-pwd">Current password</Label>
            <Input
              id="cur-pwd"
              type="password"
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
        )}
        {mode !== 'remove' && (
          <>
            <div>
              <Label htmlFor="new-pwd">New password</Label>
              <Input
                id="new-pwd"
                type="password"
                autoFocus={mode === 'set'}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="confirm-pwd">Confirm new password</Label>
              <Input
                id="confirm-pwd"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </>
        )}
        {mode === 'remove' && (
          <p className="text-sm text-navy/60">
            The file will open without a password after this. Enter the current password to confirm.
          </p>
        )}
      </div>
    </Modal>
  );
}
