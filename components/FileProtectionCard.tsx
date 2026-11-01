'use client';
/**
 * Company > Security (and Users & Roles): "Protect this company file with passwords" (filecrypto).
 *
 * Shows whether the open company file is protected (encrypted; only its own user names and
 * passwords open it, on any computer), who can open it, and — for an Admin of every company —
 * turns protection on and makes a new recovery key. Both ask for the Admin's password again and
 * show the recovery key ONCE (RecoveryKeyPanel). `highlight` (from ?protect=1 after an Admin's
 * sign-in) draws attention to the offer. `compact` is the short summary for Users & Roles.
 */
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button, Card, Input, Label, Spinner, toast } from '@/components/ui';
import { RecoveryKeyPanel } from '@/components/FileProtection';
import { api } from '@/lib/client';

export interface ProtectionUserStatus {
  userId: string;
  name: string;
  login: string;
  canOpen: boolean;
  challenge: 'ok' | 'missing' | 'none';
}

export interface ProtectionStatus {
  singleFile: boolean;
  protected: boolean;
  keyAvailable: boolean;
  protectedAt: string | null;
  recoveryCreatedAt: string | null;
  canManage: boolean;
  self: { canOpen: boolean; challenge: 'ok' | 'missing' | 'none' } | null;
  users: ProtectionUserStatus[] | null;
}

export const NEEDS_SLOT_TEXT = 'Needs to sign in once, or an Admin resets their password';

/** The protection status of the open company file (null while loading or when unavailable). */
export function useProtectionStatus(): [ProtectionStatus | null, () => Promise<void>] {
  const [status, setStatus] = React.useState<ProtectionStatus | null>(null);
  const load = React.useCallback(async () => {
    try {
      setStatus(await api.get<ProtectionStatus>('/api/file-protection'));
    } catch {
      setStatus(null);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);
  return [status, load];
}

function companyNameGuess(): string {
  if (typeof document === 'undefined') return 'Company';
  return document.title.split(/[-–|]/)[0].trim() || 'Company';
}

export function FileProtectionCard({ highlight = false, onDone }: { highlight?: boolean; onDone?: () => void }) {
  const [status, reload] = useProtectionStatus();
  const [password, setPassword] = React.useState('');
  const [mode, setMode] = React.useState<null | 'protect' | 'rekey'>(highlight ? 'protect' : null);
  const [busy, setBusy] = React.useState(false);
  const [recoveryKey, setRecoveryKey] = React.useState<string | null>(null);
  const [companyName, setCompanyName] = React.useState('Company');

  React.useEffect(() => {
    fetch('/api/company-file/info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((i: { companyName?: string | null } | null) => setCompanyName(i?.companyName || companyNameGuess()))
      .catch(() => setCompanyName(companyNameGuess()));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!mode) return;
    setBusy(true);
    try {
      const r = await api.post<{ recoveryKey: string }>(mode === 'protect' ? '/api/file-protection' : '/api/file-protection/recovery-key', { password });
      setPassword('');
      setRecoveryKey(r.recoveryKey);
      toast(mode === 'protect' ? 'The company file is protected with passwords. It is saved encrypted from now on.' : 'A new recovery key was made. The old one stops opening the file at the next save.', 'success');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryKey) {
    return (
      <Card className="p-6 max-w-xl ring-2 ring-electric/40">
        <RecoveryKeyPanel
          recoveryKey={recoveryKey}
          companyName={companyName}
          onDone={() => {
            setRecoveryKey(null);
            setMode(null);
            onDone?.();
          }}
        />
      </Card>
    );
  }

  return (
    <Card className={`p-6 max-w-xl ${highlight ? 'ring-2 ring-electric/40' : ''}`} id="file-protection">
      <div className="flex items-start gap-3 mb-3">
        {status?.protected ? <ShieldCheck className="h-5 w-5 text-emerald mt-0.5 flex-none" aria-hidden /> : <Lock className="h-5 w-5 text-electric mt-0.5 flex-none" aria-hidden />}
        <div>
          <h2 className="text-lg font-bold text-navy">Company file passwords</h2>
          <p className="text-sm text-navy/60">
            A protected company file is encrypted. Its own user names and passwords open it — on any computer with Ironbooks, and
            nowhere else. Backups, copies and the working copy on the file server are protected the same way.
          </p>
        </div>
      </div>

      {!status ? (
        <div className="flex items-center gap-2 text-navy/40 text-sm py-2">
          <Spinner className="h-4 w-4" /> Checking…
        </div>
      ) : status.protected ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-emerald font-semibold">
            <CheckCircle2 className="h-5 w-5" aria-hidden /> This company file is protected with passwords.
          </p>
          {status.protectedAt && <p className="text-xs text-navy/50">Protected since {new Date(status.protectedAt).toLocaleDateString()}.</p>}
          {!status.keyAvailable && (
            <p className="text-sm text-amber-700">Sign out and sign in again with your user name and password, so this computer can save the file.</p>
          )}
          {status.self && !status.self.canOpen && <p className="text-sm text-amber-700">Your own password does not open the file yet: sign out and sign in again.</p>}
          {status.self?.challenge === 'missing' && (
            <p className="text-sm text-amber-700">Your challenge answer does not open the file yet: set your challenge question again below.</p>
          )}
          {status.users && (
            <div>
              <p className="text-sm font-semibold text-navy mb-1">Who can open this file</p>
              <ul className="divide-y divide-navy/5 rounded-lg border border-navy/10">
                {status.users.map((u) => (
                  <li key={u.userId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      {u.name} <span className="text-navy/40">({u.login})</span>
                    </span>
                    {u.canOpen ? (
                      <span className="text-emerald text-xs font-semibold flex-none">Can open it</span>
                    ) : (
                      <span className="text-amber-700 text-xs font-semibold flex-none text-right">{NEEDS_SLOT_TEXT}</span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-navy/50 mt-1">
                Reset a password in <Link href="/users" className="text-electric hover:underline">Users &amp; Roles</Link>.
              </p>
            </div>
          )}
          {status.canManage && status.keyAvailable && (
            <p className="text-sm text-navy/70">
              {status.recoveryCreatedAt ? `Recovery key made ${new Date(status.recoveryCreatedAt).toLocaleDateString()}. ` : ''}
              Lost it, or someone else may have seen it? Make a new one; the old one stops opening the file.
            </p>
          )}
          {status.canManage && status.keyAvailable && mode !== 'rekey' && (
            <Button variant="secondary" onClick={() => setMode('rekey')}>
              Make a New Recovery Key…
            </Button>
          )}
        </div>
      ) : !status.singleFile ? (
        <p className="text-sm text-navy/70 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 flex-none" aria-hidden />
          Only a single company file (.ironbooks) can be protected. Save this company as a single company file first (File &gt; Save as a
          Single Company File), then come back here.
        </p>
      ) : status.canManage ? (
        <div className="space-y-2">
          <p className="text-sm text-amber-700 flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 mt-0.5 flex-none" aria-hidden />
            This company file is not protected: anyone who copies it can read the books with other software.
          </p>
          {mode !== 'protect' && <Button onClick={() => setMode('protect')}>Protect This Company File with Passwords…</Button>}
        </div>
      ) : (
        <p className="text-sm text-navy/70">This company file is not protected with passwords. An Admin can turn protection on here.</p>
      )}

      {mode && status?.canManage && (
        <form onSubmit={submit} className="mt-4 space-y-3 border-t border-navy/10 pt-4">
          <p className="text-sm text-navy/70">
            {mode === 'protect'
              ? 'Enter your password to protect the file. You get a recovery key next: print it or save it. Users who have not signed in since get their access the next time they sign in (or when you reset their password).'
              : 'Enter your password to make a new recovery key.'}
          </p>
          <div>
            <Label htmlFor="fp-password">Your password</Label>
            <Input id="fp-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          </div>
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>
              {mode === 'protect' ? 'Protect the File' : 'Make the New Key'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setMode(null)} disabled={busy}>
              {highlight && mode === 'protect' ? 'Not Now' : 'Cancel'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** Users & Roles: the users whose password does not open the protected file yet (Admins only). */
export function ProtectionUsersNotice() {
  const [status] = useProtectionStatus();
  if (!status?.protected || !status.users) return null;
  const missing = status.users.filter((u) => !u.canOpen);
  if (!missing.length) return null;
  return (
    <Card className="p-4 mb-4 border-amber-200 bg-amber-50/60">
      <p className="text-sm font-semibold text-navy flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden /> The company file is protected with passwords
      </p>
      <p className="text-sm text-navy/70 mt-1">
        {missing.map((u) => u.name).join(', ')} {missing.length === 1 ? 'needs' : 'need'} to sign in once while the file is open here, or an
        Admin resets {missing.length === 1 ? 'their password' : 'their passwords'} (Reset Password below). Until then they can&apos;t open
        the file on another computer. <Link href="/security#file-protection" className="text-electric hover:underline">Details</Link>
      </p>
    </Card>
  );
}
